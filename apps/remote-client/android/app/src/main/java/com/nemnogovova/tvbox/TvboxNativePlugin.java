package com.nemnogovova.tvbox;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.KeyEvent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Native glue for the TVBox remote:
 *  - hardware volume keys -> "volumeButton" events (controls the TV volume)
 *  - magnet: links, .torrent files and shared text -> "incoming" events
 *  - openExternal(url) to open the system browser (Google sign-in)
 */
@CapacitorPlugin(name = "TvboxNative")
public class TvboxNativePlugin extends Plugin {
    private static TvboxNativePlugin instance;
    private static volatile boolean volumeKeysEnabled = true;
    private final List<JSObject> pending = new ArrayList<>();
    private static final Pattern LINK = Pattern.compile("(magnet:\\?\\S+|https?://\\S+)", Pattern.CASE_INSENSITIVE);

    @Override
    public void load() {
        instance = this;
        Intent intent = getActivity().getIntent();
        if (intent != null) handleIntent(intent);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    /** Called from MainActivity.dispatchKeyEvent. Returns true when the key was consumed. */
    public static boolean handleKey(KeyEvent event) {
        TvboxNativePlugin p = instance;
        if (p == null || !volumeKeysEnabled) return false;
        int code = event.getKeyCode();
        if (code != KeyEvent.KEYCODE_VOLUME_UP && code != KeyEvent.KEYCODE_VOLUME_DOWN) return false;
        if (!p.hasListeners("volumeButton")) return false;
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            JSObject data = new JSObject();
            data.put("direction", code == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down");
            p.notifyListeners("volumeButton", data);
        }
        return true;
    }

    private void handleIntent(Intent intent) {
        JSObject item = null;
        try {
            String action = intent.getAction();
            if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
                Uri uri = intent.getData();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
                if (scheme.equals("magnet")) {
                    item = new JSObject();
                    item.put("kind", "magnet");
                    item.put("url", uri.toString());
                } else if (scheme.equals("content") || scheme.equals("file")) {
                    item = readTorrent(uri);
                } else if (scheme.startsWith("http")) {
                    item = new JSObject();
                    item.put("kind", "url");
                    item.put("url", uri.toString());
                }
            } else if (Intent.ACTION_SEND.equals(action)) {
                String text = intent.getStringExtra(Intent.EXTRA_TEXT);
                Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (text != null) {
                    Matcher m = LINK.matcher(text);
                    if (m.find()) {
                        String url = m.group(1);
                        item = new JSObject();
                        item.put("kind", url.toLowerCase().startsWith("magnet:") ? "magnet" : "url");
                        item.put("url", url);
                    }
                } else if (stream != null) {
                    item = readTorrent(stream);
                }
            }
        } catch (Exception ignored) {
            item = null;
        }
        if (item == null) return;
        // don't process the same intent twice (e.g. on activity recreation)
        getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        if (hasListeners("incoming")) notifyListeners("incoming", item);
        else synchronized (pending) { pending.add(item); }
    }

    private JSObject readTorrent(Uri uri) throws Exception {
        String name = "file.torrent";
        try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = c.getString(idx);
            }
        } catch (Exception ignored) {
        }
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            int total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > 8 * 1024 * 1024) return null;
                out.write(buf, 0, n);
            }
            JSObject o = new JSObject();
            o.put("kind", "torrent");
            o.put("name", name);
            o.put("torrentBase64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            return o;
        }
    }

    @PluginMethod
    public void consumePending(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (pending) {
            for (JSObject o : pending) arr.put(o);
            pending.clear();
        }
        JSObject ret = new JSObject();
        ret.put("items", arr);
        call.resolve(ret);
    }

    /** Background control: notification + lock-screen controls + volume keys while the screen is off. */
    @PluginMethod
    public void startRemoteService(PluginCall call) {
        String server = call.getString("server", "");
        String token = call.getString("token", "");
        if (server == null || server.isEmpty() || token == null || token.isEmpty()) {
            call.reject("server and token required");
            return;
        }
        if (android.os.Build.VERSION.SDK_INT >= 33
                && androidx.core.content.ContextCompat.checkSelfPermission(getContext(), android.Manifest.permission.POST_NOTIFICATIONS)
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            androidx.core.app.ActivityCompat.requestPermissions(getActivity(), new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 7302);
        }
        try {
            RemoteService.start(getContext(), server, token);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void stopRemoteService(PluginCall call) {
        RemoteService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getAppInfo(PluginCall call) {
        JSObject out = new JSObject();
        try {
            android.content.pm.PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            out.put("version", pi.versionName);
            out.put("build", android.os.Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode);
        } catch (Exception e) {
            out.put("version", "");
        }
        call.resolve(out);
    }

    @PluginMethod
    public void setVolumeKeysEnabled(PluginCall call) {
        volumeKeysEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        call.resolve();
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("url required");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Cannot open browser", e);
        }
    }
}
