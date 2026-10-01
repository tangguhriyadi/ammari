export function FieldError({ id, children }: { id: string; children: string }) {
  return (
    <span id={id} role="alert" className="text-sm text-danger-700">
      {children}
    </span>
  );
}
