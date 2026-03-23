export interface DynamicConfig {
  title: string;
  scratch_color: string;
  scratch_threshold: number;
  scratch_sound: boolean;
  show_confetti: boolean;
  victory_sound: boolean;
  overlay_image_url: string;
  bg_color: string;
}

export interface Dynamic {
  id: string;
  account_id: string;
  type: string;
  name: string;
  slug: string;
  description: string;
  config: DynamicConfig;
  is_active: boolean;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface DynamicItem {
  id: string;
  dynamic_id: string;
  option_ids: string[];
  image_url: string;
  thought_text: string;
  author: string;
  tipo: string;
  file_size: number;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

export interface DynamicOption {
  id: string;
  dynamic_id: string;
  name: string;
  emoji: string;
  sort_order: number;
  item_count: number;
  created_at: string;
}

export interface DynamicLink {
  id: string;
  dynamic_id: string;
  slug: string;
  whatsapp_enabled: boolean;
  whatsapp_message: string;
  extra_message_text: string;
  extra_message_media_url: string;
  extra_message_media_type: string;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
}

export interface DynamicLinkRegistration {
  id: string;
  link_id: string;
  full_name: string;
  phone: string;
  age: number;
  created_at: string;
}

export const DEFAULT_CONFIG: DynamicConfig = {
  title: '✨ Raspa y Descubre ✨',
  scratch_color: '#b8b8b8',
  scratch_threshold: 45,
  scratch_sound: true,
  show_confetti: true,
  victory_sound: true,
  overlay_image_url: '',
  bg_color: '#0f172a',
};
