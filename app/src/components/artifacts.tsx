import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Muted } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { API_URL } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * A project's images of one kind — drafts drawn for a question about how it
 * should look, or screenshots of what was built — fetched from its machine.
 */
export function Artifacts({ id, kind, match }: { id: string; kind: 'drafts' | 'renders'; match?: (path: string) => boolean }) {
  const { api, token } = useAuth();
  const [paths, setPaths] = useState<string[]>([]);

  useEffect(() => {
    api<string[]>(`/projects/${id}/artifacts`)
      .then((all) => setPaths(all.filter((p) => p.startsWith(`${kind}/`) && /\.(png|jpe?g)$/.test(p) && (!match || match(p)))))
      .catch(() => setPaths([]));
  }, [api, id, kind, match]);

  if (paths.length === 0 || !token) return null;
  return (
    <View style={styles.list}>
      {paths.map((p) => (
        <View key={p} style={styles.item}>
          <Image
            source={{ uri: `${API_URL}/projects/${id}/artifact?path=${encodeURIComponent(p)}`, headers: { authorization: `Bearer ${token}` } }}
            style={styles.image}
            contentFit="contain"
            transition={150}
          />
          <Muted>{p.split('/').pop()}</Muted>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: Spacing.three },
  item: { gap: Spacing.one },
  image: { width: '100%', aspectRatio: 4 / 3, borderRadius: 10 },
});
