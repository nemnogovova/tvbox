import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.nemnogovova.tvbox',
  appName: 'TVBox Пульт',
  webDir: 'dist',
  backgroundColor: '#0b0c10',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
