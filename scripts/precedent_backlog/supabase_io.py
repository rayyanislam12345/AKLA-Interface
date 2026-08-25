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


class SupabaseClient:
    def __init__(self, url: str, service_role_key: str, session_email: str | None = None, session_password: str | None = None):
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

    def _get_session_token(self) -> str:
        """ingest-documents validates the caller via supabase.auth.getUser()
        — confirmed in practice that the service-role key fails this (it's
        not a real user session, just a project-level credential), so
        anything reaching that function needs a genuine signed-in session.
        Signs in as a dedicated service account (not the real admin's
        credentials) and caches the token until shortly before it expires."""
        if self._session_token and time.time() < self._session_expires_at - 60:
            return self._session_token
        resp = requests.post(
            f"{self.auth_url}/token",
            params={"grant_type": "password"},
            headers={"apikey": self.service_role_key, "Content-Type": "application/json"},
            json={"email": self.session_email, "password": self.session_password},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        self._session_token = data["access_token"]
        self._session_expires_at = time.time() + data.get("expires_in", 3600)
        return self._session_token

    def list_document_types(self) -> list[dict]:
        resp = requests.get(
            f"{self.rest_url}/document_types",
            headers=self.headers,
            params={"select": "id,category,name"},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def create_document_type(self, name: str, category: str) -> dict:
        resp = requests.post(
            f"{self.rest_url}/document_types",
            headers={**self.headers, "Content-Type": "application/json", "Prefer": "return=representation"},
            json={"name": name, "category": category},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()[0]

    def upload_precedent_file(self, document_type_id: str, filename: str, data: bytes) -> str:
        storage_path = f"precedent/{document_type_id}/{int(time.time() * 1000)}-{_safe_storage_filename(filename)}"
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        resp = requests.post(
            f"{self.storage_url}/object/precedent-library/{storage_path}",
            headers={**self.headers, "Content-Type": content_type},
            data=data,
            timeout=120,
        )
        resp.raise_for_status()
        return storage_path

    def process_document(self, file_path: str, file_name: str, file_type: str, document_type_id: str):
        headers = {
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {self._get_session_token()}",
            "Content-Type": "application/json",
        }
        resp = requests.post(
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
        resp.raise_for_status()
        return resp.json()
