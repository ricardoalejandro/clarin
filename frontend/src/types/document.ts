export interface DocumentTemplate {
  id: string
  account_id: string
  name: string
  description: string
  canvas_json: Record<string, unknown>
  thumbnail_url: string
  page_width: number
  page_height: number
  page_orientation: 'portrait' | 'landscape'
  fields_used: string[]
  created_by?: string
  created_at: string
  updated_at: string
}
