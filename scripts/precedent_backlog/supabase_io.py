"""Talks to the AKLA Matter Hub's Supabase project: reads document_types,
creates new ones when a tier-2 proposal is approved, and — for --confirm —
uploads to the precedent-library bucket and invokes the same process-document
Edge Function the app's own UI uses (usePrecedentLibrary.ts), so ingestion
behaves identically to a lawyer uploading through the Precedent Library page.
"""

from __future__ import annotations

import mimetypes
import re
import time

import requests

# Supabase Storage rejects object keys with certain characters — confirmed
# in practice (400 Bad Request) on real filenames containing brackets and
# commas, e.g. "EPC Amendment Agreement [Execution Draft] [September 09,
# 2022].docx" (same issue independently hit and fixed for whatsapp-
# dashboard's sync). Only the STORAGE KEY needs this — fileName sent to
# process-document (just metadata/extension detection) keeps the real name.
def _safe_storage_filename(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9 ._-]", "_", name)[:150]


# This Mac's network has repeatedly shown transient blips over the course of
# this project (DNS resolution failures, SSL EOF errors, read timeouts) —
# confirmed to crash a whole --confirm run on nothing more than one bad
# request. Every outbound call retries a few times with backoff before
# giving up, rather than one blip taking the whole run down. Retries on
# connection-level failures and 5xx (genuinely transient); a 4xx is a real
# error (bad auth, bad request) that won't succeed on retry, so those raise
# immediately.
def _request_with_retry(method: str, url: str, *, max_attempts: int = 4, **kwargs) -> "requests.Response":
    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = requests.request(method, url, **kwargs)
            resp.raise_for_status()
            return resp
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            last_exc = exc
        except requests.exceptions.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else None
            if not status or status < 500:
                raise
            last_exc = exc
        if attempt < max_attempts:
            time.sleep(5 * attempt)
    raise last_exc


class SupabaseClient:
    def __init__(
        self,
        url: str,
        service_role_key: str,
        session_email: str | None = None,
        session_password: str | None = None,
        ocr_service_url: str | None = None,
        ocr_service_secret: str | None = None,
    ):
        self.base_url = url.rstrip("/")
        self.rest_url = f"{self.base_url}/rest/v1"
        self.storage_url = f"{self.base_url}/storage/v1"
        self.functions_url = f"{self.base_url}/functions/v1"
        self.auth_url = f"{self.base_url}/auth/v1"
        self.service_role_key = service_role_key
        self.headers = {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
        }
        self.session_email = session_email
        self.session_password = session_password
        self._session_token: str | None = None
        self._session_expires_at = 0.0
        self.ocr_service_url = ocr_service_url.rstrip("/") if ocr_service_url else None
        self.ocr_service_secret = ocr_service_secret

    @property
    def ocr_configured(self) -> bool:
        return bool(self.ocr_service_url and self.ocr_service_secret)

    def _get_session_token(self) -> str:
        """ingest-documents validates the caller via supabase.auth.getUser()
        — confirmed in practice that the service-role key fails this (it's
        not a real user session, just a project-level credential), so
        anything reaching that function needs a genuine signed-in session.
        Signs in as a dedicated service account (not the real admin's
        credentials) and caches the token until shortly before it expires."""
        if self._session_token and time.time() < self._session_expires_at - 60:
            return self._session_token
        resp = _request_with_retry(
            "POST",
            f"{self.auth_url}/token",
            params={"grant_type": "password"},
            headers={"apikey": self.service_role_key, "Content-Type": "application/json"},
            json={"email": self.session_email, "password": self.session_password},
            timeout=30,
        )
        data = resp.json()
        self._session_token = data["access_token"]
        self._session_expires_at = time.time() + data.get("expires_in", 3600)
        return self._session_token

    def list_document_types(self) -> list[dict]:
        resp = _request_with_retry(
            "GET",
            f"{self.rest_url}/document_types",
            headers=self.headers,
            params={"select": "id,category,name"},
            timeout=30,
        )
        return resp.json()

    def create_document_type(self, name: str, category: str) -> dict:
        resp = _request_with_retry(
            "POST",
            f"{self.rest_url}/document_types",
            headers={**self.headers, "Content-Type": "application/json", "Prefer": "return=representation"},
            json={"name": name, "category": category},
            timeout=30,
        )
        return resp.json()[0]

    def upload_precedent_file(self, document_type_id: str, filename: str, data: bytes) -> str:
        storage_path = f"precedent/{document_type_id}/{int(time.time() * 1000)}-{_safe_storage_filename(filename)}"
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        _request_with_retry(
            "POST",
            f"{self.storage_url}/object/precedent-library/{storage_path}",
            headers={**self.headers, "Content-Type": content_type},
            data=data,
            timeout=120,
        )
        return storage_path

    def process_document(self, file_path: str, file_name: str, file_type: str, document_type_id: str):
        headers = {
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {self._get_session_token()}",
            "Content-Type": "application/json",
        }
        resp = _request_with_retry(
            "POST",
            f"{self.functions_url}/process-document",
            headers=headers,
            json={
                "filePath": file_path,
                "fileName": file_name,
                "fileType": file_type,
                "bucket": "precedent-library",
                "matterId": None,
                "documentTypeId": document_type_id,
                "isPrecedent": True,
            },
            timeout=180,
        )
        return resp.json()

    def ocr_pdf(self, data: bytes) -> str:
        """Calls the dedicated OCR service (ocr-service/app.py, its own VM)
        directly. Unlike process-document, this has no Supabase platform
        time limit — confirmed the hard way that a long scanned agreement
        (50+ pages, ~11-13s/page on that VM's single core) blows past
        Supabase's hard 400s edge-function ceiling no matter how anything
        is tuned. A plain local HTTP call has no such limit, so this is how
        the backlog handles the long scans process_document alone can't.
        No auto-retry (max_attempts=1) — a multi-minute OCR call failing
        isn't worth silently doubling the wait; let it surface and get
        retried deliberately."""
        resp = _request_with_retry(
            "POST",
            f"{self.ocr_service_url}/ocr/pdf",
            headers={
                "Authorization": f"Bearer {self.ocr_service_secret}",
                "Content-Type": "application/pdf",
            },
            data=data,
            timeout=1800,
            max_attempts=1,
        )
        return resp.json()["text"]

    def ingest_document_text(
        self,
        content: str,
        metadata: dict,
        *,
        document_type_id: str | None = None,
        is_precedent: bool = False,
        is_statute: bool = False,
    ):
        """Same end result as process_document() — chunk, embed via Voyage,
        insert into documents — but for text already extracted ourselves
        (OCR, or a scraper that downloads its own source PDFs), so it calls
        ingest-documents directly rather than having process-document
        redundantly re-download a file from storage and re-attempt an
        extraction we already know isn't needed. Shared by the precedent
        backlog (is_precedent) and the law library scraper (is_statute) —
        the two corpora live in the same documents/RAG table but stay
        distinguishable in retrieval by these flags."""
        headers = {
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {self._get_session_token()}",
            "Content-Type": "application/json",
        }
        resp = _request_with_retry(
            "POST",
            f"{self.functions_url}/ingest-documents",
            headers=headers,
            json={
                "content": content,
                "metadata": metadata,
                "matterId": None,
                "documentTypeId": document_type_id,
                "isPrecedent": is_precedent,
                "isStatute": is_statute,
            },
            timeout=180,
        )
        return resp.json()
