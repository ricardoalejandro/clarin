'use client'

import OperationalDatePicker from '../operational-date/OperationalDatePicker'
import type { OperationalDatePickerProps } from '../operational-date/OperationalDatePicker'

type Props = Omit<OperationalDatePickerProps, 'mode' | 'showQuickValues'>

export default function TaskDateTimePicker(props: Props) {
  return <OperationalDatePicker mode="datetime" showQuickValues {...props} />
}
