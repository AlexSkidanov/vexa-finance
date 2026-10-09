import type { Metadata } from 'next';
import { AuditReportView } from '@/components/audit-report';

export const metadata: Metadata = {
  title: 'Audit report',
  description: 'A view key report, decrypted in this browser.',
  robots: { index: false, follow: false },
};

export default function AuditReportPage() {
  return <AuditReportView />;
}
