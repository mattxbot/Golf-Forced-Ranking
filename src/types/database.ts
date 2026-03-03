export type CourseType =
  | "links"
  | "parkland"
  | "desert"
  | "mountain"
  | "resort"
  | "municipal"
  | "private";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          username: string;
          display_name: string | null;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          username: string;
          display_name?: string | null;
          avatar_url?: string | null;
        };
        Update: {
          username?: string;
          display_name?: string | null;
          avatar_url?: string | null;
          updated_at?: string;
        };
      };
      courses: {
        Row: {
          id: string;
          name: string;
          slug: string;
          city: string | null;
          state_province: string | null;
          country: string;
          latitude: number | null;
          longitude: number | null;
          architect: string | null;
          year_built: number | null;
          course_type: CourseType | null;
          holes: number;
          par: number | null;
          website_url: string | null;
          image_url: string | null;
          walkability: number | null;
          scenery: number | null;
          conditioning: number | null;
          strategy_complexity: number | null;
          difficulty: number | null;
          architectural_interest: number | null;
          historical_significance: number | null;
          exclusivity: number | null;
          vibe: number | null;
          is_verified: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          city?: string | null;
          state_province?: string | null;
          country?: string;
          latitude?: number | null;
          longitude?: number | null;
          architect?: string | null;
          year_built?: number | null;
          course_type?: CourseType | null;
          holes?: number;
          par?: number | null;
          website_url?: string | null;
          image_url?: string | null;
          walkability?: number | null;
          scenery?: number | null;
          conditioning?: number | null;
          strategy_complexity?: number | null;
          difficulty?: number | null;
          architectural_interest?: number | null;
          historical_significance?: number | null;
          exclusivity?: number | null;
          vibe?: number | null;
          is_verified?: boolean;
          created_by?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["courses"]["Insert"]>;
      };
      user_courses: {
        Row: {
          id: string;
          user_id: string;
          course_id: string;
          date_played: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          course_id: string;
          date_played?: string | null;
          notes?: string | null;
        };
        Update: {
          date_played?: string | null;
          notes?: string | null;
        };
      };
      comparisons: {
        Row: {
          id: string;
          user_id: string;
          course_a_id: string;
          course_b_id: string;
          winner: "a" | "b";
          decided_in_ms: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          course_a_id: string;
          course_b_id: string;
          winner: "a" | "b";
          decided_in_ms?: number | null;
        };
        Update: {
          winner?: "a" | "b";
          decided_in_ms?: number | null;
          updated_at?: string;
        };
      };
      comparison_history: {
        Row: {
          id: string;
          user_id: string;
          course_a_id: string;
          course_b_id: string;
          winner: "a" | "b";
          decided_in_ms: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          course_a_id: string;
          course_b_id: string;
          winner: "a" | "b";
          decided_in_ms?: number | null;
        };
        Update: never;
      };
      user_events: {
        Row: {
          id: string;
          user_id: string;
          event_type: string;
          payload: Record<string, unknown>;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          event_type: string;
          payload?: Record<string, unknown>;
        };
        Update: never;
      };
      user_ranking_cache: {
        Row: {
          id: string;
          user_id: string;
          rankings: RankingEntry[];
          is_stale: boolean;
          algorithm_version: number;
          computed_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          rankings: RankingEntry[];
          is_stale?: boolean;
          algorithm_version?: number;
          computed_at?: string;
        };
        Update: {
          rankings?: RankingEntry[];
          is_stale?: boolean;
          algorithm_version?: number;
          computed_at?: string;
          updated_at?: string;
        };
      };
    };
  };
}

export interface RankingEntry {
  course_id: string;
  bt_score: number;
  rank: number;
  comparison_count: number;
  confidence: number;
}

// Convenience type aliases
export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type Course = Database["public"]["Tables"]["courses"]["Row"];
export type UserCourse = Database["public"]["Tables"]["user_courses"]["Row"];
export type Comparison = Database["public"]["Tables"]["comparisons"]["Row"];
export type UserRankingCache = Database["public"]["Tables"]["user_ranking_cache"]["Row"];
