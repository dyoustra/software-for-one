import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import type { ModelChoices } from '@sfo/api';
import { ModelPicker } from '@/components/models';
import { Button, ErrorText, Loading, Muted, Page } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { put, useCached } from '@/lib/cache';

/** This project's model choices, which win over your defaults for it alone. */
export default function ProjectModels() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useAuth();
  const path = `/projects/${id}/models`;
  const { data, error } = useCached<ModelChoices>(path);
  const [draft, setDraft] = useState<ModelChoices | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const shown = draft ?? data;

  async function save() {
    if (!shown) return;
    setSaving(true);
    setProblem(null);
    try {
      const fresh = await api<ModelChoices>(path, { method: 'PUT', body: shown });
      put(path, fresh);
      setDraft(null);
      setSaved(true);
    } catch (err) {
      setProblem(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page>
      <Stack.Screen options={{ title: 'Models' }} />
      <ErrorText error={error ?? problem} />
      {!shown && !error && <Loading label="Reading its model choices…" />}
      {shown && (
        <>
          <Muted>For this project only. Each stage uses them from its next start.</Muted>
          <ModelPicker
            value={shown}
            onChange={(v) => {
              setDraft(v);
              setSaved(false);
            }}
          />
          <Button title={saved ? 'Saved' : 'Save for this project'} busy={saving} disabled={!draft} onPress={save} />
        </>
      )}
    </Page>
  );
}
