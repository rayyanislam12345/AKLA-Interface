"""Ingest approved SharePoint precedents through the backlog tool's own confirm().

The files are cloud-only and the Mac's disk is nearly full, so each one is
copied into an empty staging folder, handed back to the cloud, ingested from
the staged copy, and the staged copy deleted. The manifest row keeps the
SharePoint path (source_path) so the record says where each came from.

    python3 ingest_sp.py data/approved.json [limit]
"""
import json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
BACKLOG = os.path.dirname(HERE)
sys.path.insert(0, BACKLOG)
os.chdir(BACKLOG)
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(BACKLOG, ".env"))
import ingest  # noqa: E402
from supabase_io import SupabaseClient  # noqa: E402

STAGE = os.path.join(HERE, "data", "stage")
EVICT = os.path.join(HERE, "evict")


def main():
    approved = json.load(open(os.path.join(HERE, sys.argv[1]) if not os.path.isabs(sys.argv[1]) else sys.argv[1]))
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else len(approved)
    sb = SupabaseClient(
        os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        os.environ["SUPABASE_SESSION_EMAIL"], os.environ["SUPABASE_SESSION_PASSWORD"],
        ocr_service_url=os.environ.get("OCR_SERVICE_URL"), ocr_service_secret=os.environ.get("OCR_SERVICE_SECRET"),
    )
    manifest = ingest.load_manifest()
    done = {r.get("source_path") for r in manifest.values() if r.get("outcome") == "ingested"}
    todo = [a for a in approved if a["path"] not in done][:limit]
    print(f"{len(todo)} to ingest ({len(done)} SharePoint files already in)", flush=True)
    os.makedirs(STAGE, exist_ok=True)
    for n, a in enumerate(todo, 1):
        print(f"[{n}/{len(todo)}] {a['filename']}", flush=True)
        staged = os.path.join(STAGE, a["filename"])
        # The download and the staged copy both land on a nearly full disk.
        while shutil.disk_usage(STAGE).free < 1_000_000_000 + 2 * a.get("size", 0):
            print("  (low disk, waiting)", flush=True)
            time.sleep(60)
        shutil.copyfile(a["path"], staged)
        subprocess.run([EVICT, a["path"]], capture_output=True)
        key = ingest.manifest_key(a["path"], os.stat(staged).st_mtime)
        row = {
            "path": staged, "source_path": a["path"], "filename": a["filename"], "folder": "SharePoint",
            "tier": "sharepoint", "reasoning": a.get("reason", ""),
        }
        if a.get("document_type_id"):
            row.update(outcome="pending_ingest", document_type_id=a["document_type_id"], document_type_name=a.get("type"))
        else:
            row.update(outcome="pending_ingest_new_type", proposed_type_name=a["new_type_name"],
                       proposed_type_category=a["new_type_category"])
        manifest[key] = row
        try:
            ingest.confirm(manifest, STAGE, sb)
        finally:
            # From here on the row points at its SharePoint home; the staged
            # copy was only ever a transit file.
            manifest[key]["path"] = a["path"]
            ingest.save_manifest(manifest)
            os.remove(staged)
        print(f"  -> {manifest[key]['outcome']}", flush=True)
        if n < len(todo):
            time.sleep(ingest.INGEST_THROTTLE_SECONDS)


if __name__ == "__main__":
    main()
