import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ProjectCard } from '@/components/project-card';
import { ErrorText, Heading, Muted, Page, Telemetry } from '@/components/ui';
import { useProjects } from '@/lib/projects';
import { byAttention } from '@/lib/pipeline';

/** Every project, what needs the person first (THEME_SPEC §5). */
export default function Projects() {
  const { projects, error, refresh } = useProjects();
  const [refreshing, setRefreshing] = useState(false);
  const sorted = byAttention(projects ?? []);

  return (
    <Page
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await refresh();
        setRefreshing(false);
      }}>
      <View style={styles.header}>
        <Heading>Projects</Heading>
        {projects && projects.length > 0 && <Telemetry>{String(projects.length)}</Telemetry>}
      </View>
      <ErrorText error={error} />
      {projects?.length === 0 && <Muted>Nothing yet. Describe an idea on the Idea tab and it starts here.</Muted>}
      {sorted.map((p) => (
        <ProjectCard key={p.id} project={p} onPress={() => router.push({ pathname: '/project/[id]', params: { id: p.id } })} />
      ))}
    </Page>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
});
