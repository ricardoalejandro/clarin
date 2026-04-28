export type CustomFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'select'
  | 'multi_select'
  | 'checkbox'
  | 'email'
  | 'phone'
  | 'url'
  | 'currency'

export interface CustomFieldOption {
  label: string
  value: string
}

export interface CustomFieldConfig {
  options?: CustomFieldOption[]
  symbol?: string
  decimals?: number
  min?: number
  max?: number
  max_length?: number
  /** Variante de entrada para tipo `text`. `inline` = input de una línea (default),
   *  `textarea` = caja multi-línea, `rich` = editor con negrita/cursiva/subrayado. */
  text_variant?: 'inline' | 'textarea' | 'rich'
}

export interface CustomFieldDefinition {
  id: string
  account_id: string
  name: string
  slug: string
  field_type: CustomFieldType
  config: CustomFieldConfig
  is_required: boolean
  default_value: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface CustomFieldValue {
  id: string
  field_id: string
  contact_id: string
  field_name?: string
  field_slug?: string
  field_type?: CustomFieldType
  value_text?: string | null
  value_number?: number | null
  value_date?: string | null
  value_bool?: boolean | null
  value_json?: string[] | null
  created_at: string
  updated_at: string
}

export interface CustomFieldFilter {
  field_id: string
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'between' | 'contains' | 'starts_with' | 'in' | 'contains_any' | 'contains_all' | 'is_empty' | 'is_not_empty'
  value: string | number | boolean | string[] | [number, number]
}
