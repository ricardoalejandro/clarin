export function surveyNonChartAnswerLabel(type: string, count: number): string {
  const noun = count === 1 ? 'respuesta' : 'respuestas';
  switch (type) {
    case 'date': return `${count} ${noun} con fecha`;
    case 'email': return `${count} ${count === 1 ? 'dirección de correo' : 'direcciones de correo'}`;
    case 'phone': return `${count} ${count === 1 ? 'número de teléfono' : 'números de teléfono'}`;
    case 'file_upload': return `${count} ${count === 1 ? 'archivo adjunto' : 'archivos adjuntos'}`;
    default: return `${count} ${noun}`;
  }
}
