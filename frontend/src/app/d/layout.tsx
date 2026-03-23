export default function PublicDynamicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 overflow-auto z-[100]">
      {children}
    </div>
  );
}
