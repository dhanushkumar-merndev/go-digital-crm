const fs = require('fs');

const path = 'src/features/leads/lead-detail-workspace.tsx';
let content = fs.readFileSync(path, 'utf8');

// Add missing lucide-react imports
const importMatch = content.match(/import \{([\s\S]*?)\} from 'lucide-react';/);
if (importMatch) {
  let imports = importMatch[1];
  const newImports = ['Bot', 'CarFront', 'MessageSquareText', 'Pencil', 'FileText', 'Plus'].filter(i => !imports.includes(i));
  if (newImports.length > 0) {
    imports = imports + ', ' + newImports.join(', ');
    content = content.replace(importMatch[0], `import {${imports}} from 'lucide-react';`);
  }
}

// Add LeadHeaderValue and InformationGrid functions
const addFunctions = `
function LeadHeaderValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1.5 min-h-5 text-sm font-semibold">{children}</div>
    </div>
  );
}

function InformationGrid({ values }: { values: Array<[string, React.ReactNode]> }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {values.map(([label, value]) => (
        <div key={label}>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <div className="mt-1.5 text-sm font-semibold">{value || '—'}</div>
        </div>
      ))}
    </div>
  );
}
`;
content = content.replace(/function formatDate/, addFunctions + '\nfunction formatDate');

// Rewrite LeadOverview
const oldOverviewStr = `function LeadOverview({ data, role }: { data: LeadDetail; role: string }) {`;
const newOverviewStr = `function LeadOverview({ data, role }: { data: LeadDetail; role: string }) {
  const lead = data.lead;
  return (
    <div className="grid gap-6 xl:grid-cols-[1.4fr_.8fr]">
      <div className="space-y-6">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Customer information</CardTitle>
          </CardHeader>
          <CardContent>
            <InformationGrid
              values={[
                ['Customer UUID', lead.customer_id ?? 'Not linked'],
                ['Primary phone', lead.phone],
                ['Primary email', lead.email ?? '—'],
                ['Customer since', formatDate(lead.created_at, false)],
                ['Address', '—'],
                ['Known contacts', '0'],
              ]}
            />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CarFront className="size-4 text-blue-600" /> Current opportunity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <InformationGrid
              values={[
                ['Lead ID', lead.id.slice(0, 8).toUpperCase()],
                ['Interested model', lead.interested_model ?? '—'],
                [
                  'Lifecycle',
                  <StatusBadge
                    key="lifecycle"
                    value={lead.lifecycle_status}
                  />,
                ],
                [
                  'Temperature',
                  lead.temperature ? (
                    <StatusBadge key="temperature" value={lead.temperature} />
                  ) : (
                    '—'
                  ),
                ],
                ['Branch', lead.branch_name],
                ['Sales owner', lead.assigned_user_name ?? 'Unassigned'],
                ['Source', lead.source],
                ['Campaign', lead.campaign ?? '—'],
                ['Last activity', formatDate(lead.updated_at)],
              ]}
            />
          </CardContent>
        </Card>
      </div>
      <div className="space-y-6">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Contact identifiers</CardTitle>
            <CardDescription>
              Identifiers may repeat across different customer UUIDs.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">No additional contacts.</p>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Recent notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">No customer notes yet.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}`;

content = content.replace(/function LeadOverview[\s\S]*?function Timeline/, newOverviewStr + '\n\nfunction Timeline');

// Remove DetailGrid since it's replaced by InformationGrid
content = content.replace(/function DetailGrid[\s\S]*?function LeadOverview/, 'function LeadOverview');

fs.writeFileSync(path, content, 'utf8');
