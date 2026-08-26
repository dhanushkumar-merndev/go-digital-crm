const fs = require('fs');

const path = 'src/features/leads/lead-detail-workspace.tsx';
let content = fs.readFileSync(path, 'utf8');

// Replace the return statement structure
const oldReturnStr = `
  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href={roleLeadListHref(role)}>
          <ArrowLeft className="size-4" /> Back to leads
        </Link>
      </Button>
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-5">
          <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-center">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5 xl:gap-8">
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold">{lead.customer_name}</h1>
                  <StatusBadge value={lead.lifecycle_status} />
                </div>
                <a
                  href={\`tel:\${lead.phone}\`}
                  className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700 hover:text-blue-700"
                >
                  <Phone className="size-4" /> {lead.phone}
                </a>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Interested model</p>
                <p className="mt-1 font-semibold">{lead.interested_model ?? 'Not captured'}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Lead source</p>
                <p className="mt-1 font-semibold">{lead.source}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Temperature</p>
                <p className="mt-1 font-semibold">{temperatureLabel(lead.temperature)}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Assigned to</p>
                <p className="mt-1 font-semibold">{lead.assigned_user_name ?? 'Unassigned'}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 xl:justify-end">
              <Button asChild variant="outline" size="sm">
                <a href={\`tel:\${lead.phone}\`}>
                  <Phone className="size-4 text-emerald-600" /> Call
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={toWhatsAppClickToChatUrl(lead.phone)} target="_blank" rel="noreferrer">
                  <WhatsAppIcon className="size-4 text-emerald-600" /> WhatsApp
                </a>
              </Button>
              {lead.email && (
                <Button asChild variant="outline" size="sm">
                  <a href={\`mailto:\${lead.email}\`}>
                    <Mail className="size-4 text-blue-600" /> Email
                  </a>
                </Button>
              )}
              {data.access.can_followups && (
                <Button size="sm" onClick={() => setScheduleOpen(true)}>
                  <CalendarClock className="size-4" /> Schedule follow-up
                </Button>
              )}
              {data.access.can_update && lead.lifecycle_status !== 'Lost' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setLostOpen(true)}
                >
                  <CircleAlert className="size-4" /> Mark lost
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      <Tabs defaultValue="overview">
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-none border-b bg-transparent p-0">
          <TabsTrigger
            value="overview"
            className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="timeline"
            className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
          >
            Timeline
          </TabsTrigger>
          {data.access.can_calls && (
            <TabsTrigger
              value="calls"
              className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
            >
              Calls{' '}
              <Badge variant="secondary" className="ml-1.5">
                {data.counts.calls}
              </Badge>
            </TabsTrigger>
          )}
          {data.access.can_messages && (
            <TabsTrigger
              value="messages"
              className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
            >
              Messages{' '}
              <Badge variant="secondary" className="ml-1.5">
                {data.counts.messages}
              </Badge>
            </TabsTrigger>
          )}
          {data.access.can_followups && (
            <TabsTrigger
              value="followups"
              className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
            >
              Follow-ups{' '}
              <Badge variant="secondary" className="ml-1.5">
                {data.counts.followups}
              </Badge>
            </TabsTrigger>
          )}
          {data.access.can_appointments && (
            <TabsTrigger
              value="appointments"
              className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
            >
              Appointments{' '}
              <Badge variant="secondary" className="ml-1.5">
                {data.counts.appointments}
              </Badge>
            </TabsTrigger>
          )}
        </TabsList>`;

const newReturnStr = `
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-3">
          <Link href={roleLeadListHref(role)}>
            <ArrowLeft className="size-4" /> Back
          </Link>
        </Button>
        <Card className="overflow-hidden shadow-none">
          <CardContent className="p-0">
            <div className="grid gap-5 p-5 sm:grid-cols-2 xl:grid-cols-[1.45fr_repeat(4,minmax(0,1fr))]">
              <div className="min-w-0 xl:border-r xl:pr-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-2xl font-bold tracking-tight">
                    {lead.customer_name}
                  </h1>
                  {lead.work_state && (
                    <StatusBadge value={lead.work_state} />
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  {lead.phone && (
                    <a
                      className="inline-flex items-center gap-1.5 font-medium text-foreground hover:text-primary"
                      href={\`tel:\${lead.phone}\`}
                    >
                      <Phone className="size-4 text-emerald-600" /> {lead.phone}
                    </a>
                  )}
                  {lead.email && <span>{lead.email}</span>}
                </div>
              </div>
              <LeadHeaderValue label="Interested model">
                {lead.interested_model ?? 'Not recorded'}
              </LeadHeaderValue>
              <LeadHeaderValue label="Lead stage">
                {lead.lifecycle_status ? (
                  <StatusBadge value={lead.lifecycle_status} />
                ) : (
                  'No visible lead'
                )}
              </LeadHeaderValue>
              <LeadHeaderValue label="Temperature">
                {lead.temperature ? (
                  <StatusBadge value={lead.temperature} />
                ) : (
                  'Not recorded'
                )}
              </LeadHeaderValue>
              <LeadHeaderValue label="Sales owner">
                {lead.assigned_user_name ?? 'Unassigned'}
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  {lead.branch_name ?? 'No branch visible'}
                </span>
              </LeadHeaderValue>
            </div>
            <div className="flex flex-wrap gap-2 border-t p-3">
              <Button size="sm" variant="outline" asChild>
                <a href={\`tel:\${lead.phone}\`}>
                  <Phone className="size-3.5 text-emerald-600" /> Call
                </a>
              </Button>
              {data.access.can_calls && (
                <Button size="sm" variant="outline">
                  <Bot className="size-3.5 text-violet-600" /> Call AI
                </Button>
              )}
              {lead.customer_id && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={\`/\${role}/customers/\${lead.customer_id}\`}>
                    <Pencil className="size-3.5 text-blue-600" /> Edit customer
                  </Link>
                </Button>
              )}
              {data.access.can_messages && (
                <Button size="sm" variant="outline">
                  <MessageSquareText className="size-3.5 text-blue-600" /> Messages
                </Button>
              )}
              {data.access.can_followups && (
                <Button size="sm" variant="outline" onClick={() => setScheduleOpen(true)}>
                  <CalendarClock className="size-3.5 text-orange-600" /> Follow-up
                </Button>
              )}
              {data.access.can_appointments && (
                <Button size="sm" variant="outline">
                  <CarFront className="size-3.5 text-blue-600" /> Test drive
                </Button>
              )}
              <Button size="sm" variant="outline">
                <FileText className="size-3.5 text-violet-600" /> Quotation
              </Button>
              <Button size="sm" className="ml-auto">
                Open bookings
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div className="overflow-x-auto pb-1">
            <TabsList className="h-auto min-w-max justify-start">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="leads">Leads</TabsTrigger>
              {data.access.can_calls && (
                <TabsTrigger value="calls">Calls</TabsTrigger>
              )}
              {data.access.can_messages && (
                <TabsTrigger value="messages">Conversations</TabsTrigger>
              )}
              {data.access.can_followups && (
                <TabsTrigger value="followups">Follow-ups</TabsTrigger>
              )}
              {data.access.can_appointments && (
                <TabsTrigger value="appointments">Appointments</TabsTrigger>
              )}
              <TabsTrigger value="test-drives">Test Drives</TabsTrigger>
              <TabsTrigger value="quotations">Quotations</TabsTrigger>
              <TabsTrigger value="bookings">Bookings</TabsTrigger>
              <TabsTrigger value="vehicles">Vehicles</TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
            </TabsList>
          </div>
          {lead.customer_id && (
            <Button size="sm" className="shrink-0" asChild>
              <Link href={\`/\${role}/customers/\${lead.customer_id}\`}>
                <Plus className="size-4" /> Edit customer
              </Link>
            </Button>
          )}
        </div>`;

content = content.replace(oldReturnStr, newReturnStr);
fs.writeFileSync(path, content, 'utf8');
