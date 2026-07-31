export function dashboardSidebarHeaderState(collapsed: boolean, mobileOpen: boolean) {
  const compact = collapsed && !mobileOpen
  return {
    compact,
    showBrand: !compact,
    showExpandControl: compact,
    showCollapseControl: !compact,
  }
}
