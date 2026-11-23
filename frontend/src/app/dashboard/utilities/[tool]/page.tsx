import { notFound } from 'next/navigation'
import { utilityById, utilities } from '@/components/utilities/catalog'
import { UtilitiesLibrary } from '@/components/utilities/library/UtilitiesLibrary'

export function generateStaticParams() {
  return utilities.map(utility => ({ tool: utility.id }))
}

export default async function UtilityPage({ params }: { params: Promise<{ tool: string }> }) {
  const utility = utilityById((await params).tool)
  if (!utility) notFound()
  return <UtilitiesLibrary initialTool={utility.id} />
}
