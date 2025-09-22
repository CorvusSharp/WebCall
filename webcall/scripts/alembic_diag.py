#!/usr/bin/env python
"""Alembic diagnostic & stamping helper.

Usage examples (run inside container or local venv):
  python -m app.scripts.alembic_diag              # show current + heads + history tail
  python -m app.scripts.alembic_diag --stamp 0006_telegram_links  # force single version
  python -m app.scripts.alembic_diag --force-reset 0006_telegram_links  # DELETE all rows then INSERT

It avoids need for psql client; uses direct SQL via SQLAlchemy Engine.
"""
from __future__ import annotations
import argparse
import sys
from typing import Optional
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text
import os


def load_config() -> Config:
    cfg = Config(os.path.join(os.path.dirname(__file__), '..', '..', 'alembic.ini'))
    cfg.set_main_option('script_location', os.path.join(os.path.dirname(__file__), '..', '..', 'alembic'))
    return cfg


def get_engine():
    database_url = os.getenv('DATABASE_URL')
    if not database_url:
        print('ERROR: DATABASE_URL not set', file=sys.stderr)
        sys.exit(2)
    # alembic.ini may also define this, but we prioritize env
    return create_engine(database_url, future=True)


def show_state(engine, script: ScriptDirectory):
    with engine.connect() as conn:
        rows = conn.execute(text('SELECT version_num FROM alembic_version')).fetchall()
    versions_db = [r[0] for r in rows]
    heads = script.get_heads()
    print('--- DB versions (alembic_version table) ---')
    for v in versions_db:
        marker = ' (HEAD?)' if v in heads else ''
        print(f'  {v}{marker}')
    print('\n--- Declared heads from code ---')
    for h in heads:
        print(f'  {h}')
    # history tail
    tail = list(script.walk_revisions())[:10]
    print('\n--- History (top 10 newest) ---')
    for rev in tail:
        print(f'{rev.revision} <- {rev.down_revision}')
    print('\nIf you see more than one head above, you have a split heads situation.')


def stamp(engine, version: str, force_reset: bool):
    with engine.begin() as conn:
        if force_reset:
            conn.execute(text('DELETE FROM alembic_version'))
        # check existing
        existing = {r[0] for r in conn.execute(text('SELECT version_num FROM alembic_version'))}
        if force_reset or len(existing) != 1 or version not in existing:
            if not force_reset and existing and version not in existing:
                print(f'Info: existing versions {existing} do not match target -> replacing with {version}')
                conn.execute(text('DELETE FROM alembic_version'))
            conn.execute(text('INSERT INTO alembic_version (version_num) VALUES (:v)'), {'v': version})
    print(f'Stamped DB alembic_version to {version}')


def main(argv: Optional[list[str]] = None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--stamp', metavar='REV', help='Stamp DB to given revision if mismatch (non-destructive).')
    ap.add_argument('--force-reset', metavar='REV', help='Delete all rows then insert single revision.')
    args = ap.parse_args(argv)

    cfg = load_config()
    script = ScriptDirectory.from_config(cfg)
    engine = get_engine()

    if args.force_reset and args.stamp:
        print('Use either --stamp or --force-reset, not both', file=sys.stderr)
        return 2

    if args.force_reset:
        stamp(engine, args.force_reset, force_reset=True)
    elif args.stamp:
        stamp(engine, args.stamp, force_reset=False)

    show_state(engine, script)


if __name__ == '__main__':  # pragma: no cover
    main()
