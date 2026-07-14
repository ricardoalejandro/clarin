import type { ReportDefinition } from '@/types/report'

export const REPORT_CATALOG: ReportDefinition[] = [
  {
    id: 'whatsapp-group-coverage',
    title: 'Cobertura de integrantes de WhatsApp',
    description: 'Compara los integrantes de un grupo con los contactos y oportunidades de Clarin.',
    category: 'WhatsApp',
    href: '/dashboard/reports/whatsapp-group-coverage',
    icon: 'whatsapp',
  },
  {
    id: 'lead-intelligence',
    title: 'Análisis inteligente de leads',
    description: 'Prioriza leads para llamadas, WhatsApp y difusión cruzando CRM, conversaciones y participación.',
    category: 'Leads',
    href: '/dashboard/reports/lead-intelligence',
    usesAI: true,
    icon: 'sparkles',
  },
]
