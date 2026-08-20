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
          id: string
          matter_id: string | null
          title: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          matter_id?: string | null
          title?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          matter_id?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_chat_threads_matter_id_fkey"
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
          id: string
          is_ai_generated: boolean
          matter_document_id: string
          storage_path: string
          uploaded_by: string | null
          version_number: number
        }
        Insert: {
          created_at?: string
          id?: string
          is_ai_generated?: boolean
          matter_document_id: string
          storage_path: string
          uploaded_by?: string | null
          version_number: number
        }
        Update: {
          created_at?: string
          id?: string
          is_ai_generated?: boolean
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
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
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
          filter_document_type_id?: string
          filter_matter_id?: string
          match_count?: number
          match_threshold?: number
          precedent_only?: boolean
          query_embedding: string
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
      redline_status: ["pending", "accepted", "rejected"],
      task_status: ["open", "in_progress", "done"],
    },
  },
} as const
