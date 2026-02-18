import { format, isToday, isYesterday } from 'date-fns'
import { es } from 'date-fns/locale'

export const formatTime = (dateString?: string) => {
  if (!dateString) return ''
  const date = new Date(dateString)
  if (isToday(date)) return format(date, 'HH:mm')
  if (isYesterday(date)) return 'Ayer'
  return format(date, 'dd/MM/yy')
}

export const formatDate = (dateString?: string) => {
    if (!dateString) return ''
    return format(new Date(dateString), 'dd MMM yyyy, HH:mm', { locale: es })
}
