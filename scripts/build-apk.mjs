// Builds the Android APK of the remote (Capacitor).
// Usage: npm run apk            (from the repo root)
// Needs: Android SDK + JDK 17 (Android Studio ships both).
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rc = path.join(root, 'apps', 'remote-client');
const android = path.join(rc, 'android');
const native = path.join(rc, 'native-android');
const isWin = process.platform === 'win32';

const run = (cmd, cwd = root, env = process.env) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', env });
};

// ---------------------------------------------------------------- toolchain
const env = { ...process.env };
if (!env.JAVA_HOME) {
  const candidates = isWin
    ? ['C:\\Program Files\\Android\\Android Studio\\jbr', 'C:\\Program Files\\Android\\Android Studio\\jre']
    : ['/opt/android-studio/jbr', '/Applications/Android Studio.app/Contents/jbr/Contents/Home'];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) env.JAVA_HOME = found;
}
const sdk =
  env.ANDROID_HOME ||
  env.ANDROID_SDK_ROOT ||
  (isWin ? path.join(env.LOCALAPPDATA || '', 'Android', 'Sdk') : path.join(os.homedir(), 'Android', 'Sdk'));

// ---------------------------------------------------------------- web build
run('npm run build:shared');
run('npm run build -w @tvbox/remote-client');

if (!fs.existsSync(path.join(android, 'app'))) run('npx cap add android', rc);
run('npx cap sync android', rc);

// ---------------------------------------------------------------- native sources
const javaDir = path.join(android, 'app', 'src', 'main', 'java', 'com', 'nemnogovova', 'tvbox');
fs.mkdirSync(javaDir, { recursive: true });
for (const f of ['MainActivity.java', 'TvboxNativePlugin.java', 'RemoteService.java']) fs.copyFileSync(path.join(native, f), path.join(javaDir, f));
fs.copyFileSync(path.join(native, 'AndroidManifest.xml'), path.join(android, 'app', 'src', 'main', 'AndroidManifest.xml'));
fs.copyFileSync(path.join(native, 'strings.xml'), path.join(android, 'app', 'src', 'main', 'res', 'values', 'strings.xml'));

// App icon (legacy PNG icons; Android scales them per density)
const res = path.join(android, 'app', 'src', 'main', 'res');
const icon = path.join(rc, 'public', 'icons', 'icon-192.png');
for (const d of fs.readdirSync(res)) {
  if (!d.startsWith('mipmap-')) continue;
  if (d.includes('anydpi')) {
    fs.rmSync(path.join(res, d), { recursive: true, force: true });
    continue;
  }
  for (const f of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
    fs.copyFileSync(icon, path.join(res, d, f));
  }
}

// ---------------------------------------------------------------- gradle patches: version + androidx.media
const version = JSON.parse(fs.readFileSync(path.join(rc, 'package.json'), 'utf-8')).version;
const [maj, min, pat] = version.split('.').map((x) => parseInt(x, 10) || 0);
const versionCode = maj * 10000 + min * 100 + pat;
const appGradle = path.join(android, 'app', 'build.gradle');
let gradle = fs.readFileSync(appGradle, 'utf-8');
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
if (!gradle.includes('androidx.media:media')) {
  gradle = gradle.replace(/dependencies\s*\{/, `dependencies {\n    implementation "androidx.media:media:1.7.0"`);
}
// Release signing with our own key (kept next to the repo, NOT in git). A release (non-debuggable)
// build installs on old / vendor-skinned phones whose installers hang on debug builds.
const keyFile = path.join(root, '.android-release.jks');
const keyInfoFile = path.join(root, '.android-release.json');
if (!fs.existsSync(keyFile) || !fs.existsSync(keyInfoFile)) {
  const pass = crypto.randomBytes(12).toString('hex');
  const keytool = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', isWin ? 'keytool.exe' : 'keytool') : 'keytool';
  fs.rmSync(keyFile, { force: true });
  execFileSync(keytool, ['-genkeypair', '-noprompt', '-keystore', keyFile, '-storetype', 'JKS', '-alias', 'tvbox', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-storepass', pass, '-keypass', pass, '-dname', 'CN=TVBox, O=TVBox, C=RS'], { stdio: 'inherit', env });
  fs.writeFileSync(keyInfoFile, JSON.stringify({ alias: 'tvbox', password: pass }, null, 2));
  console.log(`\nСоздан ключ подписи APK: ${keyFile} — сохраните его, без него не выпустить обновление поверх установленного приложения.`);
}
const keyInfo = JSON.parse(fs.readFileSync(keyInfoFile, 'utf-8'));
const keyPath = keyFile.replace(/\\/g, '/');
gradle = gradle.replace(/\n\s*signingConfigs\s*\{[\s\S]*?\n    \}\n/, '\n');
gradle = gradle.replace(/(\n    buildTypes\s*\{)/, `
    signingConfigs {
        tvbox {
            storeFile file('${keyPath}')
            storePassword '${keyInfo.password}'
            keyAlias '${keyInfo.alias}'
            keyPassword '${keyInfo.password}'
            v1SigningEnabled true
            v2SigningEnabled true
        }
    }$1`);
if (!/release\s*\{[^}]*signingConfig/.test(gradle)) gradle = gradle.replace(/(release\s*\{)/, `$1\n            signingConfig signingConfigs.tvbox`);
fs.writeFileSync(appGradle, gradle);
console.log(`\nAndroid app version ${version} (${versionCode})`);

const localProps = path.join(android, 'local.properties');
if (!fs.existsSync(localProps) && fs.existsSync(sdk)) {
  fs.writeFileSync(localProps, `sdk.dir=${sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`);
}

// ---------------------------------------------------------------- gradle
run(isWin ? 'gradlew.bat assembleRelease' : './gradlew assembleRelease', android, env);

const apk = path.join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const outDir = path.join(root, 'release');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `TVBox-Remote-${version}.apk`);
for (const f of fs.readdirSync(outDir)) if (/^TVBox-Remote.*\.apk$/.test(f)) fs.rmSync(path.join(outDir, f), { force: true });
fs.copyFileSync(apk, out);
console.log(`\nAPK ready: ${out}`);
