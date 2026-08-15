'use client';

import { Building2, CheckCircle2, FileCheck2, LoaderCircle, UploadCloud } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createClient } from '@/lib/supabase/client';

type OnboardingContext = {
  organization_id: string;
  status: 'ONBOARDING' | 'UNDER_REVIEW' | 'CHANGES_REQUIRED';
  organization_name: string;
  legal_name: string | null;
  gst_number: string | null;
  dealer_information?: {
    registered_address?: string;
    dealership_license_number?: string;
    manufacturer_names?: string[];
    contact_phone?: string;
    contact_email?: string;
  };
  review_note?: string | null;
};

type DocumentType = 'OWNER_IDENTITY' | 'GST_CERTIFICATE' | 'DEALERSHIP_AUTHORIZATION';
type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
};

const documentLabels: Record<DocumentType, string> = {
  OWNER_IDENTITY: 'Business Owner identity evidence',
  GST_CERTIFICATE: 'GST registration certificate',
  DEALERSHIP_AUTHORIZATION: 'Dealership / manufacturer authorization',
};
const acceptedTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

function sha256Base64(buffer: ArrayBuffer) {
  return crypto.subtle.digest('SHA-256', buffer).then((digest) => {
    const bytes = new Uint8Array(digest);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
}

export function BusinessOwnerOnboarding() {
  const [context, setContext] = useState<OnboardingContext>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<string>();
  const [organizationName, setOrganizationName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [gstNumber, setGstNumber] = useState('');
  const [registeredAddress, setRegisteredAddress] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [manufacturerNames, setManufacturerNames] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [documents, setDocuments] = useState<Record<DocumentType, File | null>>({
    OWNER_IDENTITY: null,
    GST_CERTIFICATE: null,
    DEALERSHIP_AUTHORIZATION: null,
  });

  useEffect(() => {
    void (async () => {
      try {
        const { data, error: contextError } = await createClient().rpc(
          'get_tenant_onboarding_context',
        );
        if (contextError || !data) throw contextError ?? new Error('CONTEXT_MISSING');
        const next = data as OnboardingContext;
        setContext(next);
        setOrganizationName(next.organization_name ?? '');
        setLegalName(next.legal_name ?? '');
        setGstNumber(next.gst_number ?? '');
        setRegisteredAddress(next.dealer_information?.registered_address ?? '');
        setLicenseNumber(next.dealer_information?.dealership_license_number ?? '');
        setManufacturerNames(next.dealer_information?.manufacturer_names?.join(', ') ?? '');
        setContactPhone(next.dealer_information?.contact_phone ?? '');
        setContactEmail(next.dealer_information?.contact_email ?? '');
      } catch {
        setError(
          'Your onboarding record could not be loaded. Refresh or contact platform support.',
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function chooseDocument(type: DocumentType, file: File | undefined) {
    setError(undefined);
    if (!file) {
      setDocuments((current) => ({ ...current, [type]: null }));
      return;
    }
    if (!acceptedTypes.has(file.type) || file.size < 1 || file.size > 25 * 1024 * 1024) {
      setError('Documents must be PDF, JPEG, PNG or WebP and no larger than 25 MB each.');
      return;
    }
    setDocuments((current) => ({ ...current, [type]: file }));
  }

  async function uploadDocument(type: DocumentType, file: File) {
    if (!context) throw new Error('CONTEXT_MISSING');
    const supabase = createClient();
    const checksum = await sha256Base64(await file.arrayBuffer());
    const { data: presignResult, error: presignError } = await supabase.functions.invoke<
      EdgeEnvelope<{
        upload_intent_id: string;
        upload_url: string;
        required_headers: Record<string, string>;
      }>
    >('presign-upload', {
      body: {
        organization_id: context.organization_id,
        branch_id: null,
        resource_type: 'organization',
        resource_id: context.organization_id,
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
        checksum_sha256: checksum,
      },
    });
    if (presignError || !presignResult?.ok || !presignResult.data)
      throw new Error('UPLOAD_PRESIGN_FAILED');
    const upload = await fetch(presignResult.data.upload_url, {
      method: 'PUT',
      headers: presignResult.data.required_headers,
      body: file,
    });
    if (!upload.ok) throw new Error('UPLOAD_TRANSFER_FAILED');
    const { data: finalizeResult, error: finalizeError } = await supabase.functions.invoke<
      EdgeEnvelope<{ object_file_id: string }>
    >('object-upload-finalize', {
      body: { upload_intent_id: presignResult.data.upload_intent_id },
    });
    if (finalizeError || !finalizeResult?.ok || !finalizeResult.data)
      throw new Error('UPLOAD_FINALIZE_FAILED');
    return { document_type: type, object_file_id: finalizeResult.data.object_file_id };
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    if (!context) return;
    const missing = (Object.keys(documentLabels) as DocumentType[]).find(
      (type) => !documents[type],
    );
    if (missing) {
      setError(`Select ${documentLabels[missing].toLowerCase()} before submitting.`);
      return;
    }
    if (
      organizationName.trim().length < 2 ||
      legalName.trim().length < 2 ||
      !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstNumber.trim().toUpperCase()) ||
      registeredAddress.trim().length < 10 ||
      licenseNumber.trim().length < 3 ||
      contactPhone.trim().length < 7 ||
      !/^\S+@\S+\.\S+$/.test(contactEmail.trim())
    ) {
      setError('Complete the company, GST, dealer address, licence and contact details.');
      return;
    }

    setSubmitting(true);
    try {
      const uploaded = [];
      for (const type of Object.keys(documentLabels) as DocumentType[]) {
        setProgress(`Uploading ${documentLabels[type]}…`);
        uploaded.push(await uploadDocument(type, documents[type] as File));
      }
      setProgress('Submitting for platform review…');
      const { error: submitError } = await createClient().rpc('submit_tenant_onboarding', {
        target_organization_name: organizationName.trim(),
        target_legal_name: legalName.trim(),
        target_gst_number: gstNumber.trim().toUpperCase(),
        target_dealer_information: {
          registered_address: registeredAddress.trim(),
          dealership_license_number: licenseNumber.trim(),
          manufacturer_names: manufacturerNames
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
            .slice(0, 20),
          contact_phone: contactPhone.trim(),
          contact_email: contactEmail.trim().toLowerCase(),
        },
        target_documents: uploaded,
        target_request_id: crypto.randomUUID(),
      });
      if (submitError) throw submitError;
      window.location.reload();
    } catch {
      setError(
        'Onboarding could not be submitted. Uploaded evidence remains private; retry or contact platform support.',
      );
    } finally {
      setSubmitting(false);
      setProgress(undefined);
    }
  }

  if (loading)
    return (
      <main className="grid min-h-screen place-items-center bg-muted/40 p-6">
        <LoaderCircle
          className="size-7 animate-spin text-primary"
          aria-label="Loading onboarding"
        />
      </main>
    );

  if (context?.status === 'UNDER_REVIEW')
    return (
      <main className="grid min-h-screen place-items-center bg-muted/40 p-6">
        <Card className="w-full max-w-lg">
          <CardContent className="flex flex-col items-center p-10 text-center">
            <div className="grid size-14 place-items-center rounded-full bg-blue-50 text-blue-700">
              <CheckCircle2 className="size-7" />
            </div>
            <h1 className="mt-5 text-xl font-bold">Onboarding is under review</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Your company information and evidence were submitted securely. CRM modules will open
              only after a Super Admin approves this dealership.
            </p>
            <Button className="mt-6" variant="outline" onClick={() => window.location.reload()}>
              Check review status
            </Button>
          </CardContent>
        </Card>
      </main>
    );

  return (
    <main className="min-h-screen bg-muted/40 p-4 md:p-8">
      <form className="mx-auto max-w-4xl space-y-6" onSubmit={(event) => void submit(event)}>
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Building2 className="size-4" /> Go Digital Marketing CRM
          </div>
          <h1 className="mt-2 text-2xl font-bold">Complete dealership onboarding</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Company evidence is private and reviewed before normal CRM access is enabled.
          </p>
        </div>
        {context?.status === 'CHANGES_REQUIRED' && context.review_note && (
          <Alert className="border-amber-200 bg-amber-50 text-amber-900">
            <AlertTitle>Changes requested</AlertTitle>
            <AlertDescription>{context.review_note}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Company and dealer information</CardTitle>
            <CardDescription>Use the legal values shown on the submitted evidence.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Dealership name">
              <Input
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
              />
            </Field>
            <Field label="Legal company name">
              <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} />
            </Field>
            <Field label="GST number">
              <Input
                value={gstNumber}
                onChange={(e) => setGstNumber(e.target.value.toUpperCase().slice(0, 15))}
              />
            </Field>
            <Field label="Dealership licence / authorization number">
              <Input value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} />
            </Field>
            <Field label="Contact phone">
              <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
            </Field>
            <Field label="Contact email">
              <Input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
              />
            </Field>
            <Field label="Authorized manufacturers (comma-separated)" className="md:col-span-2">
              <Input
                value={manufacturerNames}
                onChange={(e) => setManufacturerNames(e.target.value)}
              />
            </Field>
            <Field label="Registered dealership address" className="md:col-span-2">
              <Textarea
                rows={4}
                value={registeredAddress}
                onChange={(e) => setRegisteredAddress(e.target.value)}
              />
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Required private evidence</CardTitle>
            <CardDescription>PDF or image, maximum 25 MB per document.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            {(Object.keys(documentLabels) as DocumentType[]).map((type) => (
              <label key={type} className="rounded-lg border border-dashed p-4">
                <FileCheck2 className="size-5 text-primary" />
                <span className="mt-3 block text-sm font-medium">{documentLabels[type]}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {documents[type]?.name ?? 'No file selected'}
                </span>
                <Input
                  className="mt-3"
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  onChange={(event) => chooseDocument(type, event.target.files?.[0])}
                />
              </label>
            ))}
          </CardContent>
        </Card>
        <div className="flex flex-col items-end gap-2">
          {progress && <p className="text-sm text-muted-foreground">{progress}</p>}
          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <UploadCloud className="size-4" />
            )}
            {submitting ? 'Submitting securely…' : 'Submit for review'}
          </Button>
        </div>
      </form>
    </main>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label className="mb-2 block">{label}</Label>
      {children}
    </div>
  );
}
