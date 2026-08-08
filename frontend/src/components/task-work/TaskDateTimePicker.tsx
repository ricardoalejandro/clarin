'use client'

import OperationalDatePicker from '../operational-date/OperationalDatePicker'

interface Props {
  value: string
  onChange: (value: string) => void
  onCommit?: (value: string) => void
  label: string
  disabled?: boolean
  allDay?: boolean
  onAllDayChange?: (value: boolean) => void
  min?: string
  max?: string
  className?: string
}

export default function TaskDateTimePicker(props: Props) {
  return <OperationalDatePicker mode="datetime" showQuickValues {...props} />
}
