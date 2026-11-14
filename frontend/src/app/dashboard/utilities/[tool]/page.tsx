import { notFound } from 'next/navigation'
import { utilityById, utilities } from '@/components/utilities/catalog'
import { UtilityWorkspace } from '@/components/utilities/UtilityWorkspace'

export function generateStaticParams() {
  return utilities.map(utility => ({ tool: utility.id }))
}

export default async function UtilityPage({ params }: { params: Promise<{ tool: string }> }) {
  const utility = utilityById((await params).tool)
  if (!utility) notFound()
  return <UtilityWorkspace key={utility.id} utility={utility} />
}
