export type ToolResponseStructuredSummary = Readonly<{
  command?: string;
  error_signature?: string | null;
  file_paths?: string[];
  line_numbers?: number[];
  exit_code?: number | null;
}>;

export type ToolResponseCompression = Readonly<{
  mode: 'none' | 'extractive_summary' | 'truncated_preview';
  raw_char_count: number;
  summary_char_count: number;
  truncation_reason?: 'max_chars';
  structured_summary?: ToolResponseStructuredSummary;
}>;

export type ToolResponseRetrieval = Readonly<{
  status: 'available' | 'not_applicable';
  handle?: string;
  artifact_paths?: string[];
  mime?: string;
  chunk_count?: number;
  not_applicable_reason?: string;
}>;
