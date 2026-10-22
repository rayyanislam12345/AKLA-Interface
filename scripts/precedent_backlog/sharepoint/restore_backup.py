"""Put deleted precedent-library entries back from a backup folder.

Each backup file holds one entry's documents rows exactly as they were,
embeddings included. Re-inserting them fires the same triggers as an ingest,
so the search passages and clause bank rebuild themselves.

    python3 restore_backup.py data/deleted_backup_2026-10-22            # all
    python3 restore_backup.py data/deleted_backup_2026-10-22 "DCA 0702"  # filenames starting so
"""
import glob, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
# tsv is generated from content; the database fills it in.
SKIP = {"tsv"}


def sql(q):
    out = subprocess.run([os.path.join(HERE, "sql.sh"), q], capture_output=True, text=True).stdout
    if '"message"' in out:
        raise RuntimeError(out[:500])
    return out


def main():
    folder = os.path.join(HERE, sys.argv[1]) if not os.path.isabs(sys.argv[1]) else sys.argv[1]
    prefix = sys.argv[2] if len(sys.argv) > 2 else ""
    for path in sorted(glob.glob(os.path.join(folder, "*.json"))):
        backup = json.load(open(path))
        if not backup["entry"]["fn"].startswith(prefix):
            continue
        rows = [{k: v for k, v in r.items() if k not in SKIP} for r in backup["rows"]]
        cols = ",".join(rows[0].keys())
        # A few rows per call keeps each request well under the API's size limit.
        for i in range(0, len(rows), 20):
            payload = json.dumps(rows[i:i + 20]).replace("'", "''")
            sql(f"insert into documents ({cols}) select {cols} from jsonb_populate_recordset(null::documents, '{payload}'::jsonb) "
                f"on conflict (id) do nothing")
        print(f"restored {len(rows)} rows: {backup['entry']['fn']}")


if __name__ == "__main__":
    main()
