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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_chat_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          role: string
          thread_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          role: string
          thread_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
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
          created_at: string
          created_by: string | null
          document_version_id: string | null
          id: string
          matter_id: string | null
          title: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          document_version_id?: string | null
          id?: string
          matter_id?: string | null
          title?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          document_version_id?: string | null
          id?: string
          matter_id?: string | null
          title?: string | null
        }
        Relationships: [
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
      app_releases: {
        Row: {
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
      document_type_templates: {
        Row: {
          content_html: string
          created_at: string
          document_type_id: string
          filename: string | null
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
          required_fields: Json
          typical_stage: string | null
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          name: string
          required_fields?: Json
          typical_stage?: string | null
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          name?: string
          required_fields?: Json
          typical_stage?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      document_versions: {
        Row: {
          created_at: string
          file_name: string | null
          id: string
          is_ai_generated: boolean
          label: string | null
          matter_document_id: string
          storage_path: string
          uploaded_by: string | null
          version_number: number
        }
        Insert: {
          created_at?: string
          file_name?: string | null
          id?: string
          is_ai_generated?: boolean
          label?: string | null
          matter_document_id: string
          storage_path: string
          uploaded_by?: string | null
          version_number: number
        }
        Update: {
          created_at?: string
          file_name?: string | null
          id?: string
          is_ai_generated?: boolean
          label?: string | null
          matter_document_id?: string
          storage_path?: string
          uploaded_by?: string | null
          version_number?: number
        }
        Relationships: [
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
          content: string
          created_at: string
          created_by: string | null
          document_type_id: string | null
          embedding: string | null
          id: string
          is_precedent: boolean
          is_statute: boolean
          matter_id: string | null
          metadata: Json
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          created_by?: string | null
          document_type_id?: string | null
          embedding?: string | null
          id?: string
          is_precedent?: boolean
          is_statute?: boolean
          matter_id?: string | null
          metadata?: Json
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          created_by?: string | null
          document_type_id?: string | null
          embedding?: string | null
          id?: string
          is_precedent?: boolean
          is_statute?: boolean
          matter_id?: string | null
          metadata?: Json
          updated_at?: string
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
            foreignKeyName: "documents_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
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
          billable_hours: number | null
          external_id: string | null
          hours: number
          hub_task_id: string | null
          id: string
          matter_id: string
          narrative: string
          source: string
          task_code: string | null
          updated_at: string
          uploaded_at: string
          work_date: string
        }
        Insert: {
          ak_billable_hours?: number | null
          author_id: string
          billable_hours?: number | null
          external_id?: string | null
          hours: number
          hub_task_id?: string | null
          id?: string
          matter_id: string
          narrative: string
          source?: string
          task_code?: string | null
          updated_at?: string
          uploaded_at?: string
          work_date: string
        }
        Update: {
          ak_billable_hours?: number | null
          author_id?: string
          billable_hours?: number | null
          external_id?: string | null
          hours?: number
          hub_task_id?: string | null
          id?: string
          matter_id?: string
          narrative?: string
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
          clause_reference: string | null
          created_at: string
          document_version_id: string
          id: string
          original_text: string | null
          rationale: string | null
          review_type: string
          status: Database["public"]["Enums"]["redline_status"]
          suggested_text: string | null
        }
        Insert: {
          clause_reference?: string | null
          created_at?: string
          document_version_id: string
          id?: string
          original_text?: string | null
          rationale?: string | null
          review_type?: string
          status?: Database["public"]["Enums"]["redline_status"]
          suggested_text?: string | null
        }
        Update: {
          clause_reference?: string | null
          created_at?: string
          document_version_id?: string
          id?: string
          original_text?: string | null
          rationale?: string | null
          review_type?: string
          status?: Database["public"]["Enums"]["redline_status"]
          suggested_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "redline_suggestions_document_version_id_fkey"
            columns: ["document_version_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
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
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_firm_member: { Args: { _user_id: string }; Returns: boolean }
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
    }
    Enums: {
      app_role: "admin" | "partner" | "associate" | "paralegal"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
      app_role: ["admin", "partner", "associate", "paralegal"],
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
