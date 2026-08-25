import { useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { TEAMS } from './src/teams';

// backend/(Cloudflare Worker) 배포 후 실제 주소로 교체 - plan 4단계(계정 생성 후 wrangler
// deploy) 완료 시 여기 한 줄만 바꾸면 됨.
const BACKEND_URL = 'https://REPLACE-AFTER-DEPLOY.workers.dev';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

type Status = 'idle' | 'requesting' | 'ready' | 'subscribed' | 'error';

async function registerForPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null; // 시뮬레이터에선 실제 푸시 토큰이 안 나옴
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') return null;
  const token = await Notifications.getExpoPushTokenAsync();
  return token.data;
}

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [selectedTcode, setSelectedTcode] = useState<string | null>(null);
  const [swingThreshold, setSwingThreshold] = useState(0.05);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setStatus('requesting');
    registerForPushToken()
      .then((token) => {
        setPushToken(token);
        setStatus(token ? 'ready' : 'error');
        if (!token) setErrorMsg('실제 기기에서 알림 권한을 허용해야 구독할 수 있어요.');
      })
      .catch((e) => {
        setStatus('error');
        setErrorMsg(String(e));
      });
  }, []);

  const subscribe = async () => {
    if (!pushToken || !selectedTcode) return;
    try {
      const resp = await fetch(`${BACKEND_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expoPushToken: pushToken, tcode: selectedTcode, swingThreshold }),
      });
      if (!resp.ok) throw new Error(`서버 응답 ${resp.status}`);
      setStatus('subscribed');
      setErrorMsg(null);
    } catch (e) {
      setStatus('error');
      setErrorMsg(String(e));
    }
  };

  const selectedTeam = TEAMS.find((t) => t.tcode === selectedTcode);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>KBL 실시간 알림</Text>
        <Text style={styles.subtitle}>쿼터 종료·승률 급변·승부 역전을 응원팀 기준으로 받아보세요.</Text>

        <Text style={styles.sectionLabel}>1. 응원팀 선택</Text>
        <View style={styles.teamGrid}>
          {TEAMS.map((team) => {
            const active = team.tcode === selectedTcode;
            return (
              <TouchableOpacity
                key={team.tcode}
                onPress={() => setSelectedTcode(team.tcode)}
                style={[styles.teamChip, { borderColor: team.color }, active && { backgroundColor: team.color }]}
              >
                <Text style={[styles.teamChipText, active && styles.teamChipTextActive]}>{team.name}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.sectionLabel}>2. 승률 급변 알림 기준</Text>
        <View style={styles.thresholdRow}>
          {[0.05, 0.1].map((t) => (
            <TouchableOpacity
              key={t}
              onPress={() => setSwingThreshold(t)}
              style={[styles.thresholdChip, swingThreshold === t && styles.thresholdChipActive]}
            >
              <Text style={[styles.thresholdChipText, swingThreshold === t && styles.thresholdChipTextActive]}>
                {Math.round(t * 100)}%p 이상
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={[styles.subscribeBtn, (!selectedTcode || status === 'requesting') && styles.subscribeBtnDisabled]}
          disabled={!selectedTcode || status === 'requesting'}
          onPress={subscribe}
        >
          {status === 'requesting' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.subscribeBtnText}>
              {status === 'subscribed' ? '구독 중 - 다시 눌러 팀/기준 변경' : '알림 구독하기'}
            </Text>
          )}
        </TouchableOpacity>

        {selectedTeam && status === 'subscribed' && (
          <Text style={styles.statusOk}>{selectedTeam.name} 경기 알림을 받는 중이에요.</Text>
        )}
        {errorMsg && <Text style={styles.statusError}>{errorMsg}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f1115' },
  scroll: { padding: 20, paddingTop: 32 },
  title: { fontSize: 26, fontWeight: '800', color: '#f2f3f7' },
  subtitle: { fontSize: 13, color: '#9297a8', marginTop: 6, marginBottom: 24, lineHeight: 19 },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: '#6a6f7f', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 },
  teamGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 },
  teamChip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1.5 },
  teamChipText: { color: '#f2f3f7', fontSize: 13, fontWeight: '600' },
  teamChipTextActive: { color: '#fff' },
  thresholdRow: { flexDirection: 'row', gap: 8, marginBottom: 28 },
  thresholdChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: '#1a1d24' },
  thresholdChipActive: { backgroundColor: '#f2f3f7' },
  thresholdChipText: { color: '#9297a8', fontSize: 13, fontWeight: '600' },
  thresholdChipTextActive: { color: '#0f1115' },
  subscribeBtn: { backgroundColor: '#e4002b', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  subscribeBtnDisabled: { opacity: 0.4 },
  subscribeBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  statusOk: { color: '#3fa9f5', marginTop: 14, fontSize: 13 },
  statusError: { color: '#ff8c5a', marginTop: 14, fontSize: 13 },
});
