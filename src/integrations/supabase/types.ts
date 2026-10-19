export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      ai_artifacts: {
        Row: {
          content: string | null
          created_at: string
          created_by: string | null
          data: Json
          id: string
          kind: string
          matter_id: string | null
          message_id: string | null
          thread_id: string
          title: string
          updated_at: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          created_by?: string | null
          data?: Json
          id?: string
          kind: string
          matter_id?: string | null
          message_id?: string | null
          thread_id: string
          title: string
          updated_at?: string
        }
        Update: {
          content?: string | null
          created_at?: string
          created_by?: string | null
          data?: Json
          id?: string
          kind?: string
          matter_id?: string | null
          message_id?: string | null
          thread_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_artifacts_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_artifacts_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "ai_chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_artifacts_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "ai_chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_chat_messages: {
        Row: {
          content: string
          created_at: string
          created_by: string | null
          id: string
          metadata: Json
          role: string
          thread_id: string
        }
        Insert: {
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          metadata?: Json
          role: string
          thread_id: string
        }
        Update: {
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          metadata?: Json
          role?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_chat_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "ai_chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_chat_threads: {
        Row: {
          archived: boolean
          created_at: string
          created_by: string | null
          document_type_id: string | null
          document_version_id: string | null
          id: string
          last_message_at: string | null
          laws: Json
          matter_id: string | null
          pinned: boolean
          questionnaire: Json | null
          skill: Json | null
          title: string | null
          updated_at: string
        }
        Insert: {
          archived?: boolean
          created_at?: string
          created_by?: string | null
          document_type_id?: string | null
          document_version_id?: string | null
          id?: string
          last_message_at?: string | null
          laws?: Json
          matter_id?: string | null
          pinned?: boolean
          questionnaire?: Json | null
          skill?: Json | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          archived?: boolean
          created_at?: string
          created_by?: string | null
          document_type_id?: string | null
          document_version_id?: string | null
          id?: string
          last_message_at?: string | null
          laws?: Json
          matter_id?: string | null
          pinned?: boolean
          questionnaire?: Json | null
          skill?: Json | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_chat_threads_document_type_id_fkey"
            columns: ["document_type_id"]
            isOneToOne: false
            referencedRelation: "document_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_chat_threads_document_version_id_fkey"
            columns: ["document_version_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_chat_threads_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_research_runs: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by: string | null
          id: string
          jurisdiction: string | null
          matter_id: string | null
          question: string
          sources: Json
          status: string
          unresolved: Json
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          jurisdiction?: string | null
          matter_id?: string | null
          question: string
          sources?: Json
          status: string
          unresolved?: Json
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          jurisdiction?: string | null
          matter_id?: string | null
          question?: string
          sources?: Json
          status?: string
          unresolved?: Json
        }
        Relationships: [
          {
            foreignKeyName: "ai_research_runs_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_review_runs: {
        Row: {
          artifact_id: string | null
          coverage: Json
          created_at: string
          created_by: string | null
          document_version_id: string | null
          error: string | null
          id: string
          output_artifact_id: string | null
          passes: Json
          source_hash: string | null
          status: string
          template_path: string | null
        }
        Insert: {
          artifact_id?: string | null
          coverage?: Json
          created_at?: string
          created_by?: string | null
          document_version_id?: string | null
          error?: string | null
          id?: string
          output_artifact_id?: string | null
          passes?: Json
          source_hash?: string | null
          status?: string
          template_path?: string | null
        }
        Update: {
          artifact_id?: string | null
          coverage?: Json
          created_at?: string
          created_by?: string | null
          document_version_id?: string | null
          error?: string | null
          id?: string
          output_artifact_id?: string | null
          passes?: Json
          source_hash?: string | null
          status?: string
          template_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_review_runs_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "ai_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_review_runs_document_version_id_fkey"
            columns: ["document_version_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_review_runs_output_artifact_id_fkey"
            columns: ["output_artifact_id"]
            isOneToOne: false
            referencedRelation: "ai_artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_skills: {
        Row: {
          anthropic_skill_id: string | null
          anthropic_version_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          instructions: string
          kind: string
          name: string
          produces_document: boolean
          skill_files: Json
          updated_at: string
        }
        Insert: {
          anthropic_skill_id?: string | null
          anthropic_version_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          instructions: string
          kind?: string
          name: string
          produces_document?: boolean
          skill_files?: Json
          updated_at?: string
        }
        Update: {
          anthropic_skill_id?: string | null
          anthropic_version_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          instructions?: string
          kind?: string
          name?: string
          produces_document?: boolean
          skill_files?: Json
          updated_at?: string
        }
        Relationships: []
      }
      app_releases: {
        Row: {
          auto_install: boolean
          created_by: string | null
          id: string
          mandatory: boolean
          notes: string | null
          published_at: string
          sha256: string
          storage_path: string
          version: string
        }
        Insert: {
          auto_install?: boolean
          created_by?: string | null
          id?: string
          mandatory?: boolean
          notes?: string | null
          published_at?: string
          sha256: string
          storage_path: string
          version: string
        }
        Update: {
          auto_install?: boolean
          created_by?: string | null
          id?: string
          mandatory?: boolean
          notes?: string | null
          published_at?: string
          sha256?: string
          storage_path?: string
          version?: string
        }
        Relationships: []
      }
      caselaw_cache: {
        Row: {
          body: string
          case_id: number
          citation: string | null
          court: string | null
          fetched_at: string
          metadata: Json
          section: string
          title: string | null
          year: number | null
        }
        Insert: {
          body?: string
          case_id: number
          citation?: string | null
          court?: string | null
          fetched_at?: string
          metadata?: Json
          section: string
          title?: string | null
          year?: number | null
        }
        Update: {
          body?: string
          case_id?: number
          citation?: string | null
          court?: string | null
          fetched_at?: string
          metadata?: Json
          section?: string
          title?: string | null
          year?: number | null
        }
        Relationships: []
      }
      caselaw_messages: {
        Row: {
          content: string
          created_at: string
          created_by: string | null
          id: string
          metadata: Json
          role: string
          thread_id: string
        }
        Insert: {
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          metadata?: Json
          role: string
          thread_id: string
        }
        Update: {
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          metadata?: Json
          role?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "caselaw_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "caselaw_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      caselaw_runs: {
        Row: {
          coverage: Json | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          message_id: string | null
          plan: Json | null
          question: string
          ranked: Json | null
          status: string
          thread_id: string | null
          tier: string | null
        }
        Insert: {
          coverage?: Json | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          message_id?: string | null
          plan?: Json | null
          question: string
          ranked?: Json | null
          status?: string
          thread_id?: string | null
          tier?: string | null
        }
        Update: {
          coverage?: Json | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          message_id?: string | null
          plan?: Json | null
          question?: string
          ranked?: Json | null
          status?: string
          thread_id?: string | null
          tier?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "caselaw_runs_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "caselaw_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "caselaw_runs_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "caselaw_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      caselaw_threads: {
        Row: {
          archived: boolean
          created_at: string
          created_by: string | null
          id: string
          last_message_at: string | null
          matter_id: string | null
          pinned: boolean
          title: string | null
          updated_at: string
        }
        Insert: {
          archived?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          last_message_at?: string | null
          matter_id?: string | null
          pinned?: boolean
          title?: string | null
          updated_at?: string
        }
        Update: {
          archived?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          last_message_at?: string | null
          matter_id?: string | null
          pinned?: boolean
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "caselaw_threads_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      connector_auth_codes: {
        Row: {
          client_id: string
          code_challenge: string
          code_challenge_method: string
          code_hash: string
          created_at: string
          expires_at: string
          redirect_uri: string
          resource: string | null
          scope: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          client_id: string
          code_challenge: string
          code_challenge_method?: string
          code_hash: string
          created_at?: string
          expires_at: string
          redirect_uri: string
          resource?: string | null
          scope?: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          client_id?: string
          code_challenge?: string
          code_challenge_method?: string
          code_hash?: string
          created_at?: string
          expires_at?: string
          redirect_uri?: string
          resource?: string | null
          scope?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "connector_auth_codes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "connector_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      connector_clients: {
        Row: {
          client_name: string | null
          client_secret_hash: string | null
          client_uri: string | null
          created_at: string
          grant_types: string[]
          id: string
          last_used_at: string | null
          redirect_uris: string[]
          software_id: string | null
          token_endpoint_auth_method: string
        }
        Insert: {
          client_name?: string | null
          client_secret_hash?: string | null
          client_uri?: string | null
          created_at?: string
          grant_types?: string[]
          id: string
          last_used_at?: string | null
          redirect_uris: string[]
          software_id?: string | null
          token_endpoint_auth_method?: string
        }
        Update: {
          client_name?: string | null
          client_secret_hash?: string | null
          client_uri?: string | null
          created_at?: string
          grant_types?: string[]
          id?: string
          last_used_at?: string | null
          redirect_uris?: string[]
          software_id?: string | null
          token_endpoint_auth_method?: string
        }
        Relationships: []
      }
      connector_tokens: {
        Row: {
          client_id: string
          created_at: string
          expires_at: string
          family_id: string
          id: string
          kind: string
          last_used_at: string | null
          revoked_at: string | null
          rotated_at: string | null
          scope: string
          token_hash: string
          user_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          expires_at: string
          family_id: string
          id?: string
          kind: string
          last_used_at?: string | null
          revoked_at?: string | null
          rotated_at?: string | null
          scope?: string
          token_hash: string
          user_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          expires_at?: string
          family_id?: string
          id?: string
          kind?: string
          last_used_at?: string | null
          revoked_at?: string | null
          rotated_at?: string | null
          scope?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "connector_tokens_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "connector_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      document_index_jobs: {
        Row: {
          attempts: number
          bucket: string
          created_at: string
          document_version_id: string | null
          finished_at: string | null
          id: string
          kind: string
          last_error: string | null
          locked_until: string | null
          priority: number
          run_id: string | null
          started_at: string | null
          state: string
          storage_path: string
          worker: string | null
        }
        Insert: {
          attempts?: number
          bucket: string
          created_at?: string
          document_version_id?: string | null
          finished_at?: string | null
          id?: string
          kind?: string
          last_error?: string | null
          locked_until?: string | null
          priority?: number
          run_id?: string | null
          started_at?: string | null
          state?: string
          storage_path: string
          worker?: string | null
        }
        Update: {
          attempts?: number
          bucket?: string
          created_at?: string
          document_version_id?: string | null
          finished_at?: string | null
          id?: string
          kind?: string
          last_error?: string | null
          locked_until?: string | null
          priority?: number
          run_id?: string | null
          started_at?: string | null
          state?: string
          storage_path?: string
          worker?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "document_index_jobs_document_version_id_fkey"
            columns: ["document_version_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      document_search_chunks: {
        Row: {
          chunk_index: number
          content: string
          search_vector: unknown
          source_document_id: string
        }
        Insert: {
          chunk_index: number
          content: string
          search_vector?: unknown
          source_document_id: string
        }
        Update: {
          chunk_index?: number
          content?: string
          search_vector?: unknown
          source_document_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_search_chunks_source_document_id_fkey"
            columns: ["source_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      document_template_versions: {
        Row: {
          content_html: string | null
          created_at: string
          created_by: string | null
          document_type_id: string
          filename: string | null
          format_rules: string | null
          id: string
          storage_path: string
        }
        Insert: {
          content_html?: string | null
          created_at?: string
          created_by?: string | null
          document_type_id: string
          filename?: string | null
          format_rules?: string | null
          id?: string
          storage_path: string
        }
        Update: {
          content_html?: string | null
          created_at?: string
          created_by?: string | null
          document_type_id?: string
          filename?: string | null
          format_rules?: string | null
          id?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_template_versions_document_type_id_fkey"
            columns: ["document_type_id"]
            isOneToOne: false
            referencedRelation: "document_types"
            referencedColumns: ["id"]
          },
        ]
      }
      document_type_templates: {
        Row: {
          content_html: string
          created_at: string
          document_type_id: string
          filename: string | null
          format_rules: string | null
          id: string
          seeded_from_storage_path: string | null
          storage_path: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          content_html: string
          created_at?: string
          document_type_id: string
          filename?: string | null
          format_rules?: string | null
          id?: string
          seeded_from_storage_path?: string | null
          storage_path?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          content_html?: string
          created_at?: string
          document_type_id?: string
          filename?: string | null
          format_rules?: string | null
          id?: string
          seeded_from_storage_path?: string | null
          storage_path?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "document_type_templates_document_type_id_fkey"
            columns: ["document_type_id"]
            isOneToOne: true
            referencedRelation: "document_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_type_templates_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      document_types: {
        Row: {
          category: string
          created_at: string
          id: string
          name: string
          questionnaire: string | null
          required_fields: Json
          typical_stage: string | null
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          name: string
          questionnaire?: string | null
          required_fields?: Json
          typical_stage?: string | null
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          name?: string
          questionnaire?: string | null
          required_fields?: Json
          typical_stage?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      document_versions: {
        Row: {
          card: Json | null
          changes_from_previous: Json | null
          compared_with_version_id: string | null
          content_hash: string | null
          created_at: string
          file_name: string | null
          id: string
          indexing_attempts: number
          indexing_error: string | null
          indexing_finished_at: string | null
          indexing_started_at: string | null
          indexing_status: string
          is_ai_generated: boolean
          label: string | null
          matter_document_id: string
          page_count: number | null
          proof_check: Json | null
          storage_path: string
          uploaded_by: string | null
          version_number: number
        }
        Insert: {
          card?: Json | null
          changes_from_previous?: Json | null
          compared_with_version_id?: string | null
          content_hash?: string | null
          created_at?: string
          file_name?: string | null
          id?: string
          indexing_attempts?: number
          indexing_error?: string | null
          indexing_finished_at?: string | null
          indexing_started_at?: string | null
          indexing_status?: string
          is_ai_generated?: boolean
          label?: string | null
          matter_document_id: string
          page_count?: number | null
          proof_check?: Json | null
          storage_path: string
          uploaded_by?: string | null
          version_number: number
        }
        Update: {
          card?: Json | null
          changes_from_previous?: Json | null
          compared_with_version_id?: string | null
          content_hash?: string | null
          created_at?: string
          file_name?: string | null
          id?: string
          indexing_attempts?: number
          indexing_error?: string | null
          indexing_finished_at?: string | null
          indexing_started_at?: string | null
          indexing_status?: string
          is_ai_generated?: boolean
          label?: string | null
          matter_document_id?: string
          page_count?: number | null
          proof_check?: Json | null
          storage_path?: string
          uploaded_by?: string | null
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "document_versions_compared_with_version_id_fkey"
            columns: ["compared_with_version_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_versions_matter_document_id_fkey"
            columns: ["matter_document_id"]
            isOneToOne: false
            referencedRelation: "matter_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          char_end: number | null
          char_start: number | null
          content: string
          created_at: string
          created_by: string | null
          document_type_id: string | null
          document_version_id: string | null
          embedding: string | null
          heading_path: string | null
          id: string
          ingest_run_id: string | null
          is_ai_generated: boolean | null
          is_precedent: boolean
          is_statute: boolean
          matter_document_id: string | null
          matter_id: string | null
          metadata: Json
          page: number | null
          text_hash: string | null
          tsv: unknown
          updated_at: string
          version_number: number | null
        }
        Insert: {
          char_end?: number | null
          char_start?: number | null
          content: string
          created_at?: string
          created_by?: string | null
          document_type_id?: string | null
          document_version_id?: string | null
          embedding?: string | null
          heading_path?: string | null
          id?: string
          ingest_run_id?: string | null
          is_ai_generated?: boolean | null
          is_precedent?: boolean
          is_statute?: boolean
          matter_document_id?: string | null
          matter_id?: string | null
          metadata?: Json
          page?: number | null
          text_hash?: string | null
          tsv?: unknown
          updated_at?: string
          version_number?: number | null
        }
        Update: {
          char_end?: number | null
          char_start?: number | null
          content?: string
          created_at?: string
          created_by?: string | null
          document_type_id?: string | null
          document_version_id?: string | null
          embedding?: string | null
          heading_path?: string | null
          id?: string
          ingest_run_id?: string | null
          is_ai_generated?: boolean | null
          is_precedent?: boolean
          is_statute?: boolean
          matter_document_id?: string | null
          matter_id?: string | null
          metadata?: Json
          page?: number | null
          text_hash?: string | null
          tsv?: unknown
          updated_at?: string
          version_number?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_document_type_id_fkey"
            columns: ["document_type_id"]
            isOneToOne: false
            referencedRelation: "document_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_document_version_id_fkey"
            columns: ["document_version_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      law_library_versions: {
        Row: {
          act_name: string
          archived_at: string
          chunk_count: number | null
          content: string
          id: string
          metadata: Json
          superseded_by_update_id: string | null
        }
        Insert: {
          act_name: string
          archived_at?: string
          chunk_count?: number | null
          content: string
          id?: string
          metadata?: Json
          superseded_by_update_id?: string | null
        }
        Update: {
          act_name?: string
          archived_at?: string
          chunk_count?: number | null
          content?: string
          id?: string
          metadata?: Json
          superseded_by_update_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "law_library_versions_superseded_by_update_id_fkey"
            columns: ["superseded_by_update_id"]
            isOneToOne: false
            referencedRelation: "law_updates"
            referencedColumns: ["id"]
          },
        ]
      }
      law_monitor_candidates: {
        Row: {
          act_name: string | null
          authority_ref: string | null
          confidence: string | null
          dedupe_key: string
          fetch_attempts: number
          final: boolean
          first_seen_at: string
          found_by: string
          last_seen_at: string
          law_update_id: string | null
          published_date: string | null
          reason: string | null
          run_id: string | null
          source_name: string
          status: string
          summary: string | null
          times_seen: number
          title: string
          update_type: string | null
          url: string | null
        }
        Insert: {
          act_name?: string | null
          authority_ref?: string | null
          confidence?: string | null
          dedupe_key: string
          fetch_attempts?: number
          final?: boolean
          first_seen_at?: string
          found_by?: string
          last_seen_at?: string
          law_update_id?: string | null
          published_date?: string | null
          reason?: string | null
          run_id?: string | null
          source_name: string
          status: string
          summary?: string | null
          times_seen?: number
          title: string
          update_type?: string | null
          url?: string | null
        }
        Update: {
          act_name?: string | null
          authority_ref?: string | null
          confidence?: string | null
          dedupe_key?: string
          fetch_attempts?: number
          final?: boolean
          first_seen_at?: string
          found_by?: string
          last_seen_at?: string
          law_update_id?: string | null
          published_date?: string | null
          reason?: string | null
          run_id?: string | null
          source_name?: string
          status?: string
          summary?: string | null
          times_seen?: number
          title?: string
          update_type?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "law_monitor_candidates_law_update_id_fkey"
            columns: ["law_update_id"]
            isOneToOne: false
            referencedRelation: "law_updates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "law_monitor_candidates_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "law_monitor_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      law_monitor_runs: {
        Row: {
          acts_checked: number
          emailed: number
          error: string | null
          finished_at: string | null
          found: number
          id: string
          library_cursor: string | null
          notified: number
          pages_changed: number
          pages_checked: number
          rejected: number
          reported: number
          retried: number
          sources_checked: number
          started_at: string
          status: string
          written: number
        }
        Insert: {
          acts_checked?: number
          emailed?: number
          error?: string | null
          finished_at?: string | null
          found?: number
          id?: string
          library_cursor?: string | null
          notified?: number
          pages_changed?: number
          pages_checked?: number
          rejected?: number
          reported?: number
          retried?: number
          sources_checked?: number
          started_at?: string
          status?: string
          written?: number
        }
        Update: {
          acts_checked?: number
          emailed?: number
          error?: string | null
          finished_at?: string | null
          found?: number
          id?: string
          library_cursor?: string | null
          notified?: number
          pages_changed?: number
          pages_checked?: number
          rejected?: number
          reported?: number
          retried?: number
          sources_checked?: number
          started_at?: string
          status?: string
          written?: number
        }
        Relationships: []
      }
      law_update_digests: {
        Row: {
          digest_date: string
          generated_at: string
          run_id: string | null
          summary_markdown: string
          update_count: number
        }
        Insert: {
          digest_date: string
          generated_at?: string
          run_id?: string | null
          summary_markdown: string
          update_count?: number
        }
        Update: {
          digest_date?: string
          generated_at?: string
          run_id?: string | null
          summary_markdown?: string
          update_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "law_update_digests_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "law_monitor_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      law_update_notifications: {
        Row: {
          created_at: string
          emailed_at: string | null
          id: string
          law_update_id: string
          matter_id: string | null
          read_at: string | null
          reason: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emailed_at?: string | null
          id?: string
          law_update_id: string
          matter_id?: string | null
          read_at?: string | null
          reason: string
          user_id: string
        }
        Update: {
          created_at?: string
          emailed_at?: string | null
          id?: string
          law_update_id?: string
          matter_id?: string | null
          read_at?: string | null
          reason?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "law_update_notifications_law_update_id_fkey"
            columns: ["law_update_id"]
            isOneToOne: false
            referencedRelation: "law_updates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "law_update_notifications_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      law_updates: {
        Row: {
          act_name: string | null
          authority_ref: string | null
          confidence: string | null
          dedupe_key: string
          discovered_at: string
          document_url: string | null
          found_by: string
          id: string
          incorporation: string | null
          incorporation_note: string | null
          last_seen_at: string
          library_action: string
          library_action_at: string | null
          library_action_note: string | null
          published_date: string | null
          run_id: string | null
          source_name: string
          source_url: string | null
          summary: string | null
          tier: string
          title: string
          update_type: string
        }
        Insert: {
          act_name?: string | null
          authority_ref?: string | null
          confidence?: string | null
          dedupe_key: string
          discovered_at?: string
          document_url?: string | null
          found_by?: string
          id?: string
          incorporation?: string | null
          incorporation_note?: string | null
          last_seen_at?: string
          library_action?: string
          library_action_at?: string | null
          library_action_note?: string | null
          published_date?: string | null
          run_id?: string | null
          source_name: string
          source_url?: string | null
          summary?: string | null
          tier?: string
          title: string
          update_type: string
        }
        Update: {
          act_name?: string | null
          authority_ref?: string | null
          confidence?: string | null
          dedupe_key?: string
          discovered_at?: string
          document_url?: string | null
          found_by?: string
          id?: string
          incorporation?: string | null
          incorporation_note?: string | null
          last_seen_at?: string
          library_action?: string
          library_action_at?: string | null
          library_action_note?: string | null
          published_date?: string | null
          run_id?: string | null
          source_name?: string
          source_url?: string | null
          summary?: string | null
          tier?: string
          title?: string
          update_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "law_updates_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "law_monitor_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      law_watch_pages: {
        Row: {
          act_name: string | null
          consecutive_failures: number
          content_hash: string | null
          content_length: number | null
          enabled: boolean
          entries: Json
          entry_count: number
          first_seen_at: string
          kind: string
          last_changed_at: string | null
          last_checked_at: string | null
          last_error: string | null
          name: string
          url: string
        }
        Insert: {
          act_name?: string | null
          consecutive_failures?: number
          content_hash?: string | null
          content_length?: number | null
          enabled?: boolean
          entries?: Json
          entry_count?: number
          first_seen_at?: string
          kind: string
          last_changed_at?: string | null
          last_checked_at?: string | null
          last_error?: string | null
          name: string
          url: string
        }
        Update: {
          act_name?: string | null
          consecutive_failures?: number
          content_hash?: string | null
          content_length?: number | null
          enabled?: boolean
          entries?: Json
          entry_count?: number
          first_seen_at?: string
          kind?: string
          last_changed_at?: string | null
          last_checked_at?: string | null
          last_error?: string | null
          name?: string
          url?: string
        }
        Relationships: []
      }
      live_activity: {
        Row: {
          as_of: string
          billable_hours: number
          by_matter: Json
          current_matter: string | null
          current_task: string | null
          day: string
          other_hours: number
          state: string
          tracked_seconds: number
          user_id: string
        }
        Insert: {
          as_of?: string
          billable_hours?: number
          by_matter?: Json
          current_matter?: string | null
          current_task?: string | null
          day: string
          other_hours?: number
          state?: string
          tracked_seconds?: number
          user_id: string
        }
        Update: {
          as_of?: string
          billable_hours?: number
          by_matter?: Json
          current_matter?: string | null
          current_task?: string | null
          day?: string
          other_hours?: number
          state?: string
          tracked_seconds?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_activity_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      mandate_opportunities: {
        Row: {
          category: string | null
          close_date: string | null
          dedupe_key: string
          department: string | null
          document_url: string | null
          extra_urls: string[]
          found_at: string
          id: string
          matched_keywords: string[]
          notice_type: string | null
          notice_url: string | null
          publish_date: string | null
          source: string
          storage_folder: string | null
          synced_at: string
          tender_ref: string | null
          title: string
        }
        Insert: {
          category?: string | null
          close_date?: string | null
          dedupe_key: string
          department?: string | null
          document_url?: string | null
          extra_urls?: string[]
          found_at?: string
          id?: string
          matched_keywords?: string[]
          notice_type?: string | null
          notice_url?: string | null
          publish_date?: string | null
          source: string
          storage_folder?: string | null
          synced_at?: string
          tender_ref?: string | null
          title: string
        }
        Update: {
          category?: string | null
          close_date?: string | null
          dedupe_key?: string
          department?: string | null
          document_url?: string | null
          extra_urls?: string[]
          found_at?: string
          id?: string
          matched_keywords?: string[]
          notice_type?: string | null
          notice_url?: string | null
          publish_date?: string | null
          source?: string
          storage_folder?: string | null
          synced_at?: string
          tender_ref?: string | null
          title?: string
        }
        Relationships: []
      }
      matter_context: {
        Row: {
          content: string
          created_at: string
          id: string
          matter_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          content?: string
          created_at?: string
          id?: string
          matter_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          matter_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matter_context_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: true
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matter_context_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_documents: {
        Row: {
          created_at: string
          created_by: string | null
          document_type_id: string | null
          id: string
          last_version_number: number
          matter_id: string
          owner_id: string | null
          status: Database["public"]["Enums"]["document_status"]
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          document_type_id?: string | null
          id?: string
          last_version_number?: number
          matter_id: string
          owner_id?: string | null
          status?: Database["public"]["Enums"]["document_status"]
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          document_type_id?: string | null
          id?: string
          last_version_number?: number
          matter_id?: string
          owner_id?: string | null
          status?: Database["public"]["Enums"]["document_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "matter_documents_document_type_id_fkey"
            columns: ["document_type_id"]
            isOneToOne: false
            referencedRelation: "document_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matter_documents_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matter_documents_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_law_update_acks: {
        Row: {
          acknowledged_at: string
          acknowledged_by: string | null
          id: string
          law_update_id: string
          matter_id: string
        }
        Insert: {
          acknowledged_at?: string
          acknowledged_by?: string | null
          id?: string
          law_update_id: string
          matter_id: string
        }
        Update: {
          acknowledged_at?: string
          acknowledged_by?: string | null
          id?: string
          law_update_id?: string
          matter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "matter_law_update_acks_law_update_id_fkey"
            columns: ["law_update_id"]
            isOneToOne: false
            referencedRelation: "law_updates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matter_law_update_acks_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_notes: {
        Row: {
          author_id: string | null
          content: string
          created_at: string
          id: string
          matter_id: string
        }
        Insert: {
          author_id?: string | null
          content: string
          created_at?: string
          id?: string
          matter_id: string
        }
        Update: {
          author_id?: string | null
          content?: string
          created_at?: string
          id?: string
          matter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "matter_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matter_notes_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_parties: {
        Row: {
          contact_info: string | null
          created_at: string
          id: string
          matter_id: string
          name: string
          role: string
        }
        Insert: {
          contact_info?: string | null
          created_at?: string
          id?: string
          matter_id: string
          name: string
          role: string
        }
        Update: {
          contact_info?: string | null
          created_at?: string
          id?: string
          matter_id?: string
          name?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "matter_parties_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_relevant_laws: {
        Row: {
          act_name: string
          added_by: string | null
          created_at: string
          id: string
          matter_id: string
          source: string
          status: string
        }
        Insert: {
          act_name: string
          added_by?: string | null
          created_at?: string
          id?: string
          matter_id: string
          source: string
          status?: string
        }
        Update: {
          act_name?: string
          added_by?: string | null
          created_at?: string
          id?: string
          matter_id?: string
          source?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "matter_relevant_laws_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_stages: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          matter_id: string
          name: string
          sort_order: number
          status: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          matter_id: string
          name: string
          sort_order?: number
          status?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          matter_id?: string
          name?: string
          sort_order?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "matter_stages_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_stars: {
        Row: {
          created_at: string
          matter_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          matter_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          matter_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "matter_stars_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_tasks: {
        Row: {
          assignee_id: string | null
          created_at: string
          created_by: string | null
          due_date: string | null
          id: string
          matter_id: string
          status: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          id?: string
          matter_id: string
          status?: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          id?: string
          matter_id?: string
          status?: Database["public"]["Enums"]["task_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "matter_tasks_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matter_tasks_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_timeslips: {
        Row: {
          ak_billable_hours: number | null
          author_id: string
          billable: boolean
          billable_hours: number | null
          external_id: string | null
          hours: number
          hub_task_id: string | null
          id: string
          matter_id: string
          narrative: string
          sort_order: number | null
          source: string
          task_code: string | null
          updated_at: string
          uploaded_at: string
          work_date: string
        }
        Insert: {
          ak_billable_hours?: number | null
          author_id: string
          billable?: boolean
          billable_hours?: number | null
          external_id?: string | null
          hours: number
          hub_task_id?: string | null
          id?: string
          matter_id: string
          narrative: string
          sort_order?: number | null
          source?: string
          task_code?: string | null
          updated_at?: string
          uploaded_at?: string
          work_date: string
        }
        Update: {
          ak_billable_hours?: number | null
          author_id?: string
          billable?: boolean
          billable_hours?: number | null
          external_id?: string | null
          hours?: number
          hub_task_id?: string | null
          id?: string
          matter_id?: string
          narrative?: string
          sort_order?: number | null
          source?: string
          task_code?: string | null
          updated_at?: string
          uploaded_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "matter_timeslips_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matter_timeslips_hub_task_id_fkey"
            columns: ["hub_task_id"]
            isOneToOne: false
            referencedRelation: "matter_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matter_timeslips_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matters: {
        Row: {
          client_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          lead_partner_id: string | null
          matter_type: string | null
          name: string
          opened_date: string
          sector: string | null
          status: string
          target_close_date: string | null
          updated_at: string
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          lead_partner_id?: string | null
          matter_type?: string | null
          name: string
          opened_date?: string
          sector?: string | null
          status?: string
          target_close_date?: string | null
          updated_at?: string
        }
        Update: {
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          lead_partner_id?: string | null
          matter_type?: string | null
          name?: string
          opened_date?: string
          sector?: string | null
          status?: string
          target_close_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "matters_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matters_lead_partner_id_fkey"
            columns: ["lead_partner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          email_law_updates: boolean
          firm_wide_law_updates: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          email_law_updates?: boolean
          firm_wide_law_updates?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          email_law_updates?: boolean
          firm_wide_law_updates?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      precedent_passages: {
        Row: {
          body: string
          chunk_index: number | null
          document_id: string
          document_type_id: string | null
          filename: string | null
          id: number
          ordinal: number
          storage_path: string | null
          tsv: unknown
        }
        Insert: {
          body: string
          chunk_index?: number | null
          document_id: string
          document_type_id?: string | null
          filename?: string | null
          id?: never
          ordinal: number
          storage_path?: string | null
          tsv?: unknown
        }
        Update: {
          body?: string
          chunk_index?: number | null
          document_id?: string
          document_type_id?: string | null
          filename?: string | null
          id?: never
          ordinal?: number
          storage_path?: string | null
          tsv?: unknown
        }
        Relationships: [
          {
            foreignKeyName: "precedent_passages_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
          status: Database["public"]["Enums"]["profile_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          status?: Database["public"]["Enums"]["profile_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          status?: Database["public"]["Enums"]["profile_status"]
          updated_at?: string
        }
        Relationships: []
      }
      redline_suggestions: {
        Row: {
          artifact_id: string | null
          clause_reference: string | null
          created_at: string
          created_by: string | null
          decided_at: string | null
          decided_by: string | null
          document_version_id: string | null
          id: string
          message_id: string | null
          op: string
          original_text: string | null
          paragraph_index: number | null
          part: string
          placement: string
          placement_reason: string | null
          rationale: string | null
          review_run_id: string | null
          review_type: string
          revision_ids: number[]
          status: Database["public"]["Enums"]["redline_status"]
          suggested_text: string | null
          superseded_by: string | null
          thread_id: string | null
        }
        Insert: {
          artifact_id?: string | null
          clause_reference?: string | null
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          document_version_id?: string | null
          id?: string
          message_id?: string | null
          op?: string
          original_text?: string | null
          paragraph_index?: number | null
          part?: string
          placement?: string
          placement_reason?: string | null
          rationale?: string | null
          review_run_id?: string | null
          review_type?: string
          revision_ids?: number[]
          status?: Database["public"]["Enums"]["redline_status"]
          suggested_text?: string | null
          superseded_by?: string | null
          thread_id?: string | null
        }
        Update: {
          artifact_id?: string | null
          clause_reference?: string | null
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          document_version_id?: string | null
          id?: string
          message_id?: string | null
          op?: string
          original_text?: string | null
          paragraph_index?: number | null
          part?: string
          placement?: string
          placement_reason?: string | null
          rationale?: string | null
          review_run_id?: string | null
          review_type?: string
          revision_ids?: number[]
          status?: Database["public"]["Enums"]["redline_status"]
          suggested_text?: string | null
          superseded_by?: string | null
          thread_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "redline_suggestions_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "ai_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "redline_suggestions_document_version_id_fkey"
            columns: ["document_version_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "redline_suggestions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "ai_chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "redline_suggestions_review_run_id_fkey"
            columns: ["review_run_id"]
            isOneToOne: false
            referencedRelation: "ai_review_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "redline_suggestions_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "redline_suggestions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "redline_suggestions_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "ai_chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      support_requests: {
        Row: {
          created_at: string
          id: string
          message: string
          status: string
          subject: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          message: string
          status?: string
          subject: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          status?: string
          subject?: string
          user_id?: string | null
        }
        Relationships: []
      }
      timekeeper_activity: {
        Row: {
          app: string | null
          billable: boolean
          captures: Json
          confirmed: boolean
          day: string
          ended_at: number
          is_work: boolean
          kind: string
          matter_id: string | null
          matter_name: string | null
          segment_id: number
          started_at: number
          task_id: string | null
          task_title: string | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          app?: string | null
          billable?: boolean
          captures?: Json
          confirmed?: boolean
          day: string
          ended_at: number
          is_work?: boolean
          kind: string
          matter_id?: string | null
          matter_name?: string | null
          segment_id: number
          started_at: number
          task_id?: string | null
          task_title?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          app?: string | null
          billable?: boolean
          captures?: Json
          confirmed?: boolean
          day?: string
          ended_at?: number
          is_work?: boolean
          kind?: string
          matter_id?: string | null
          matter_name?: string | null
          segment_id?: number
          started_at?: number
          task_id?: string | null
          task_title?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "timekeeper_activity_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timekeeper_activity_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "matter_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timekeeper_activity_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      timekeeper_plans: {
        Row: {
          assigned_by: string | null
          created_at: string
          day: string
          id: string
          keywords: Json
          matter_id: string
          task_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_by?: string | null
          created_at?: string
          day: string
          id?: string
          keywords?: Json
          matter_id: string
          task_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_by?: string | null
          created_at?: string
          day?: string
          id?: string
          keywords?: Json
          matter_id?: string
          task_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "timekeeper_plans_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timekeeper_plans_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timekeeper_plans_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "matter_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timekeeper_plans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      timekeeper_tags: {
        Row: {
          applied_at: string | null
          created_at: string
          day: string | null
          id: string
          is_work: boolean
          key: string
          matter_id: string | null
          segment_id: number | null
          tagged_by: string | null
          task_id: string | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          applied_at?: string | null
          created_at?: string
          day?: string | null
          id?: string
          is_work?: boolean
          key: string
          matter_id?: string | null
          segment_id?: number | null
          tagged_by?: string | null
          task_id?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          applied_at?: string | null
          created_at?: string
          day?: string | null
          id?: string
          is_work?: boolean
          key?: string
          matter_id?: string | null
          segment_id?: number | null
          tagged_by?: string | null
          task_id?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "timekeeper_tags_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timekeeper_tags_tagged_by_fkey"
            columns: ["tagged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timekeeper_tags_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "matter_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timekeeper_tags_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_account_links: {
        Row: {
          created_at: string
          id: string
          profile_id: string
          whatsapp_user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          profile_id: string
          whatsapp_user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          profile_id?: string
          whatsapp_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_account_links_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_documents: {
        Row: {
          chat_name: string | null
          filename: string
          id: string
          kind: string | null
          message_at: string | null
          mimetype: string | null
          owner_id: string | null
          sender: string | null
          source_document_id: string
          source_user_id: string
          storage_path: string
          synced_at: string
          whatsapp_matter_id: string
        }
        Insert: {
          chat_name?: string | null
          filename: string
          id?: string
          kind?: string | null
          message_at?: string | null
          mimetype?: string | null
          owner_id?: string | null
          sender?: string | null
          source_document_id: string
          source_user_id: string
          storage_path: string
          synced_at?: string
          whatsapp_matter_id: string
        }
        Update: {
          chat_name?: string | null
          filename?: string
          id?: string
          kind?: string | null
          message_at?: string | null
          mimetype?: string | null
          owner_id?: string | null
          sender?: string | null
          source_document_id?: string
          source_user_id?: string
          storage_path?: string
          synced_at?: string
          whatsapp_matter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_documents_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_documents_whatsapp_matter_id_fkey"
            columns: ["whatsapp_matter_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_matters"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_matters: {
        Row: {
          aliases: string[]
          chat_history: Json
          chats: string[]
          detailed_summary: string
          id: string
          last_active_at: string | null
          matter_created_at: string | null
          matter_id: string | null
          message_count: number
          name: string
          owner_id: string | null
          source_matter_id: string
          source_user_id: string
          summary: string
          synced_at: string
        }
        Insert: {
          aliases?: string[]
          chat_history?: Json
          chats?: string[]
          detailed_summary?: string
          id?: string
          last_active_at?: string | null
          matter_created_at?: string | null
          matter_id?: string | null
          message_count?: number
          name: string
          owner_id?: string | null
          source_matter_id: string
          source_user_id: string
          summary?: string
          synced_at?: string
        }
        Update: {
          aliases?: string[]
          chat_history?: Json
          chats?: string[]
          detailed_summary?: string
          id?: string
          last_active_at?: string | null
          matter_created_at?: string | null
          matter_id?: string | null
          message_count?: number
          name?: string
          owner_id?: string | null
          source_matter_id?: string
          source_user_id?: string
          summary?: string
          synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_matters_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_matters_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_access_whatsapp_document: {
        Args: { _path: string }
        Returns: boolean
      }
      claim_index_job: {
        Args: { p_worker: string }
        Returns: {
          attempts: number
          bucket: string
          created_at: string
          document_version_id: string | null
          finished_at: string | null
          id: string
          kind: string
          last_error: string | null
          locked_until: string | null
          priority: number
          run_id: string | null
          started_at: string | null
          state: string
          storage_path: string
          worker: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "document_index_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      complete_ai_review: {
        Args: {
          p_coverage: Json
          p_passes: Json
          p_run_id: string
          p_suggestions: Json
        }
        Returns: {
          artifact_id: string | null
          clause_reference: string | null
          created_at: string
          created_by: string | null
          decided_at: string | null
          decided_by: string | null
          document_version_id: string | null
          id: string
          message_id: string | null
          op: string
          original_text: string | null
          paragraph_index: number | null
          part: string
          placement: string
          placement_reason: string | null
          rationale: string | null
          review_run_id: string | null
          review_type: string
          revision_ids: number[]
          status: Database["public"]["Enums"]["redline_status"]
          suggested_text: string | null
          superseded_by: string | null
          thread_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "redline_suggestions"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      connector_prune: { Args: never; Returns: number }
      enqueue_index_job: { Args: { p_version_id: string }; Returns: Json }
      fail_index_job: {
        Args: {
          p_error: string
          p_job_id: string
          p_retry?: boolean
          p_run_id?: string
        }
        Returns: string
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      index_supported_extension: { Args: { p_path: string }; Returns: boolean }
      is_firm_member: { Args: { _user_id: string }; Returns: boolean }
      is_supervisor: { Args: { _user_id: string }; Returns: boolean }
      law_update_recipients: {
        Args: { p_act_name: string }
        Returns: {
          matter_id: string
          matter_name: string
          user_id: string
        }[]
      }
      match_documents: {
        Args: {
          filter_act_names?: string[]
          filter_document_type_id?: string
          filter_matter_id?: string
          match_count?: number
          match_threshold?: number
          precedent_only?: boolean
          query_embedding: string
          statute_only?: boolean
        }
        Returns: {
          content: string
          document_type_id: string
          id: string
          matter_id: string
          metadata: Json
          similarity: number
        }[]
      }
      matter_documents_citing_act: {
        Args: { p_act_name: string; p_matter_id: string }
        Returns: {
          matter_document_id: string
          mentions: number
          title: string
        }[]
      }
      matter_team: {
        Args: { p_matter_id: string }
        Returns: {
          user_id: string
        }[]
      }
      pgrst_pre_request: { Args: never; Returns: undefined }
      precedent_common_lexemes: {
        Args: { min_passages: number; terms: string[] }
        Returns: string[]
      }
      precedent_lexeme_df: { Args: { terms: string[] }; Returns: number[] }
      precedent_paragraphs: {
        Args: { p_content: string }
        Returns: {
          body: string
          ordinal: number
        }[]
      }
      precedent_sources: {
        Args: never
        Returns: {
          chunk_count: number
          created_at: string
          document_type_id: string
          document_type_name: string
          filename: string
          storage_path: string
        }[]
      }
      publish_index_run: {
        Args: {
          p_card?: Json
          p_job_id: string
          p_page_count?: number
          p_run_id: string
        }
        Returns: Json
      }
      record_version_checks: {
        Args: {
          p_changes?: Json
          p_compared_with?: string
          p_proof_check?: Json
          p_run_id: string
          p_version_id: string
        }
        Returns: boolean
      }
      release_index_job: {
        Args: { p_job_id: string; p_run_id: string }
        Returns: boolean
      }
      save_ai_document: {
        Args: {
          p_create_new: boolean
          p_document_id: string
          p_document_type_id: string
          p_expected_version_id: string
          p_file_stem: string
          p_matter_id: string
          p_storage_path: string
          p_title: string
        }
        Returns: Json
      }
      save_document_version: {
        Args: {
          p_create_new: boolean
          p_document_id: string
          p_document_type_id: string
          p_expected_version_id: string
          p_extension?: string
          p_file_stem: string
          p_is_ai_generated?: boolean
          p_matter_id: string
          p_storage_path: string
          p_title: string
        }
        Returns: Json
      }
      search_passages: {
        Args: {
          act_names?: string[]
          all_versions?: boolean
          document_type_id?: string
          exclude_document_id?: string
          k?: number
          matter_id?: string
          max_ms?: number
          phrasings?: Json
          query_embedding: string
          query_text: string
          scope: string
        }
        Returns: {
          content: string
          document_version_id: string
          heading_path: string
          id: string
          keyword_rank: number
          matter_document_id: string
          metadata: Json
          name_rank: number
          page: number
          rrf_score: number
          vector_rank: number
          version_number: number
        }[]
      }
      search_precedent_passages: {
        Args: {
          p_document_type_id?: string
          p_limit?: number
          p_phrases: string[]
        }
        Returns: {
          body: string
          chunk_index: number
          document_id: string
          document_type_id: string
          filename: string
          id: number
          ordinal: number
          rank: number
          storage_path: string
        }[]
      }
      search_project_content: {
        Args: {
          p_all_versions?: boolean
          p_kind?: string
          p_limit?: number
          p_matter_id?: string
          p_offset?: number
          p_query: string
        }
        Returns: {
          created_at: string
          document_id: string
          file_name: string
          item_id: string
          kind: string
          matched_in: string
          matter_id: string
          matter_name: string
          rank: number
          snippet: string
          storage_path: string
          title: string
          total_count: number
          version_id: string
          version_number: number
        }[]
      }
      statute_sources: {
        Args: never
        Returns: {
          act_name: string
          chunk_count: number
          scraped_at: string
          source: string
          source_url: string
        }[]
      }
      touch_index_job: {
        Args: { p_job_id: string; p_run_id: string }
        Returns: boolean
      }
      unread_law_notification_count: { Args: never; Returns: number }
    }
    Enums: {
      app_role:
        | "admin"
        | "partner"
        | "associate"
        | "paralegal"
        | "senior_counsel"
        | "founder"
      document_status:
        | "not_started"
        | "drafting"
        | "internal_review"
        | "with_counterparty"
        | "negotiation"
        | "finalized"
        | "executed"
      profile_status: "pending" | "approved" | "rejected"
      redline_status: "pending" | "accepted" | "rejected"
      task_status: "open" | "in_progress" | "done"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "admin",
        "partner",
        "associate",
        "paralegal",
        "senior_counsel",
        "founder",
      ],
      document_status: [
        "not_started",
        "drafting",
        "internal_review",
        "with_counterparty",
        "negotiation",
        "finalized",
        "executed",
      ],
      profile_status: ["pending", "approved", "rejected"],
      redline_status: ["pending", "accepted", "rejected"],
      task_status: ["open", "in_progress", "done"],
    },
  },
} as const
