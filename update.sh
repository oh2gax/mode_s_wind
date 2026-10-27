#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# update.sh — update MODE-S Wind from GitHub (from 2026-10-27)
#
#   bash update.sh              show the new commits, ask, back up the
#                               database, pull, check, restart, show the log
#   bash update.sh --check      only show what an update would bring
#   bash update.sh --rollback   go back to the version before the last update
#
# Options:
#   -y, --yes          do not ask
#   --no-backup        no database copy before the update (saves SD-card writes
#                      on a Raspberry Pi; the AWS server should keep it)
#   --service NAME     systemd service to restart (default modes-wind,
#                      or the environment variable MODES_SERVICE)
#
# What it does:
#   1. git fetch; lists the new commits and the files they change
#   2. refuses when a tracked file has local edits — this machine's own
#      settings belong in config_local.py (gitignored), never in config.py
#   3. a consistent copy of the database to data/archive/pre_update_<time>.db
#      (SQLite backup API, safe while MODE-S Wind runs; the newest 3 are kept)
#   4. git merge --ff-only (never mixes in local commits)
#   5. pip install -r requirements.txt when it changed
#   6. compiles the changed Python files; on an error it goes back to the
#      previous version at once and restarts nothing
#   7. restarts the service and shows the first log lines
# The previous version and the backup are recorded in data/archive/update_state.txt
# for --rollback.  The database itself is never restored automatically
# (that would lose the data collected since) — --rollback prints the commands.
#
# Run it as the user that owns the folder (ubuntu on AWS); the restart uses sudo.
# ──────────────────────────────────────────────────────────────────────────

# Everything is inside main(), which bash reads completely before running it:
# the update may replace this very file while it runs.
main() {
    set -uo pipefail
    local here
    here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)" || exit 1
    cd "$here" || exit 1

    local SERVICE="${MODES_SERVICE:-modes-wind}" YES=0 BACKUP=1 MODE=update KEEP=3
    while [ $# -gt 0 ]; do
        case "$1" in
            -y|--yes)    YES=1 ;;
            --no-backup) BACKUP=0 ;;
            --service)   SERVICE="${2:-}"; shift ;;
            --rollback)  MODE=rollback ;;
            --check)     MODE=check ;;
            -h|--help)   sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; return 0 ;;
            *)           echo "Unknown option: $1  (bash update.sh --help)"; return 2 ;;
        esac
        shift
    done

    local PY=python3
    [ -x venv/bin/python ] && PY=venv/bin/python
    local STATE=data/archive/update_state.txt
    mkdir -p data/archive

    say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
    info() { printf '  %s\n' "$*"; }
    warn() { printf '  \033[33m! %s\033[0m\n' "$*"; }
    fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*"; exit 1; }
    ask()  {
        [ "$YES" = 1 ] && return 0
        local a; read -r -p "  $1 [y/N] " a
        [ "$a" = y ] || [ "$a" = Y ] || [ "$a" = yes ]
    }
    version() { grep -m1 '^## v\.' doc/whats_new.md 2>/dev/null | awk '{print $2}'; }

    git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
        || fail "Not a git clone — install with git clone (README, Installation)."

    require_clean() {
        if ! git diff --quiet || ! git diff --cached --quiet; then
            git status --short --untracked-files=no | sed 's/^/    /'
            fail "Local edits in tracked files (above).  Put this machine's own settings in
  config_local.py (see config_local.py.example), then restore the file:
    git checkout -- <file>"
        fi
    }

    db_path() {
        "$PY" - <<'PYEOF' 2>/dev/null | tail -n 1
import sys
sys.path.insert(0, ".")
from config import Config
import config_override
config_override.apply(Config)
print(Config.DB_PATH)
PYEOF
    }

    restart_service() {
        if systemctl cat "$SERVICE" >/dev/null 2>&1; then
            local since
            since="$(date '+%Y-%m-%d %H:%M:%S')"
            say "Restarting $SERVICE"
            sudo systemctl restart "$SERVICE" || fail "systemctl restart failed"
            sleep 10
            if systemctl is-active --quiet "$SERVICE"; then
                info "$SERVICE is running"
            else
                warn "$SERVICE is NOT running — see: journalctl -u $SERVICE -n 80"
            fi
            journalctl -u "$SERVICE" --since "$since" -n 25 --no-pager 2>/dev/null | sed 's/^/    /'
            local nerr
            nerr="$(journalctl -u "$SERVICE" --since "$since" --no-pager 2>/dev/null \
                    | grep -c -E 'Traceback|CRITICAL| ERROR ' || true)"
            [ "${nerr:-0}" -gt 0 ] && warn "$nerr error line(s) since the restart — check the log"
        else
            warn "No systemd service '$SERVICE' — restart MODE-S Wind yourself (or --service NAME)."
        fi
    }

    # ── --rollback ──────────────────────────────────────────────────────────
    if [ "$MODE" = rollback ]; then
        [ -f "$STATE" ] || fail "No earlier update recorded ($STATE)."
        local prev when bk
        read -r prev when bk < "$STATE"
        require_clean
        say "Back to the version before the update of $when"
        git log --oneline --no-decorate "$prev..HEAD" | sed 's/^/    undo  /'
        ask "Go back to ${prev:0:7}?" || { info "Nothing changed."; return 0; }
        git reset --hard "$prev" || fail "git reset failed"
        restart_service
        say "Rolled back to $(git rev-parse --short HEAD) ($(version))"
        if [ -n "${bk:-}" ] && [ -f "$bk" ]; then
            local db; db="$(db_path)"
            info "The database was NOT restored.  Only if the newer version changed the stored"
            info "data in a way the old one cannot use, restore the copy taken before the update"
            info "(the data collected since then is lost):"
            info "  sudo systemctl stop $SERVICE"
            info "  cp '$bk' '$db' && rm -f '$db-wal' '$db-shm'"
            info "  sudo systemctl start $SERVICE"
        fi
        return 0
    fi

    # ── what is new ─────────────────────────────────────────────────────────
    local branch
    branch="$(git symbolic-ref --short -q HEAD)" \
        || fail "Not on a branch (detached HEAD) — git checkout master (the repository's branch) first."
    git rev-parse -q --verify '@{u}' >/dev/null \
        || fail "Branch $branch has no upstream — git branch --set-upstream-to=origin/$branch"
    say "MODE-S Wind $(version) — checking GitHub"
    git fetch --quiet --tags || fail "git fetch failed (network?)"
    local n
    n="$(git rev-list --count 'HEAD..@{u}')"
    if [ "$n" = 0 ]; then
        info "Already up to date ($(git rev-parse --short HEAD))."
        return 0
    fi
    git merge-base --is-ancestor HEAD '@{u}' \
        || fail "This clone has its own commits that are not on GitHub — not updating."
    info "$n new commit(s):"
    git log --oneline --no-decorate 'HEAD..@{u}' | sed 's/^/    /'
    git diff --stat 'HEAD' '@{u}' | tail -n 1 | sed 's/^/   /'
    if git diff --name-only 'HEAD' '@{u}' | grep -q -E '^(database/|collector/shear\.py|run\.py)'; then
        info "(changes the database code or start-up: the first start may migrate or"
        info " recompute stored data — the backup below covers it)"
    fi
    [ "$MODE" = check ] && return 0

    require_clean
    ask "Update now?" || { info "Nothing changed."; return 0; }

    # ── backup ──────────────────────────────────────────────────────────────
    local prev bk="" db
    prev="$(git rev-parse HEAD)"
    if [ "$BACKUP" = 1 ]; then
        db="$(db_path)"
        if [ -n "$db" ] && [ -f "$db" ]; then
            local need avail
            need="$(stat -c %s "$db")"
            avail="$(df --output=avail -B1 data/archive | tail -n 1 | tr -d ' ')"
            if [ "$avail" -gt $(( need + need / 5 )) ]; then
                bk="data/archive/pre_update_$(date -u +%Y%m%d_%H%M%S).db"
                say "Database backup → $bk ($(( need / 1048576 )) MB)"
                if "$PY" - "$db" "$bk" <<'PYEOF'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1], timeout=30)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
src.close()
PYEOF
                then
                    info "done"
                    ls -1t data/archive/pre_update_*.db 2>/dev/null | tail -n +$(( KEEP + 1 )) | xargs -r rm -f
                else
                    rm -f "$bk"; bk=""
                    ask "The backup failed — update without it?" || fail "Stopped, nothing changed."
                fi
            else
                warn "Not enough free disk for a backup ($(( need / 1048576 )) MB needed)."
                ask "Update without a backup?" || fail "Stopped, nothing changed."
            fi
        else
            warn "Database not found ($db) — no backup."
        fi
    fi
    echo "$prev $(date -u +%Y-%m-%dT%H:%M:%SZ) $bk" > "$STATE"

    # ── update ──────────────────────────────────────────────────────────────
    say "Updating"
    git merge --ff-only --quiet '@{u}' || fail "git merge --ff-only failed — nothing changed."
    if git diff --name-only "$prev" HEAD | grep -qx 'requirements.txt'; then
        if [ "$PY" = venv/bin/python ]; then
            info "requirements.txt changed — pip install"
            "$PY" -m pip install --quiet -r requirements.txt || warn "pip install failed"
        else
            warn "requirements.txt changed — install the packages yourself (no venv/ here)"
        fi
    fi
    local changed
    changed="$(git diff --name-only --diff-filter=AM "$prev" HEAD -- '*.py')"
    if [ -n "$changed" ]; then
        # shellcheck disable=SC2086
        if ! "$PY" -m py_compile $changed; then
            git reset --hard --quiet "$prev"
            fail "A changed Python file does not compile — back at the previous version
  ($(git rev-parse --short HEAD)), nothing restarted."
        fi
        info "$(echo "$changed" | wc -l) changed Python file(s) compile"
    fi

    restart_service
    say "Updated to $(git rev-parse --short HEAD) — version $(version)"
    [ -n "$bk" ] && info "Database copy before the update: $bk"
    info "Undo: bash update.sh --rollback"
    return 0
}

main "$@"
exit $?
