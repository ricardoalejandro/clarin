export default function PublicFormLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 overflow-auto bg-white z-[100]">
      {children}
    </div>
  );
}
