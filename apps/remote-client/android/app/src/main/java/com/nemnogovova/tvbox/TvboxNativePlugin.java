package com.nemnogovova.tvbox;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.view.KeyEvent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

@CapacitorPlugin(name = "TvboxNative")
public class TvboxNativePlugin extends Plugin {

    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() != KeyEvent.ACTION_DOWN) {
            return false;
        }
        int code = event.getKeyCode();
        JSObject data = new JSObject();
        if (code == KeyEvent.KEYCODE_VOLUME_UP) {
            data.put("direction", "up");
            notifyListeners("volumeButton", data);
            return true;
        } else if (code == KeyEvent.KEYCODE_VOLUME_DOWN) {
            data.put("direction", "down");
            notifyListeners("volumeButton", data);
            return true;
        }
        return false;
    }

    public void handleIntent(Intent intent) {
        if (intent == null) {
            return;
        }
        Uri data = intent.getData();
        if (data == null) {
            return;
        }
        String url = data.toString();
        JSObject payload = new JSObject();
        if (url != null && url.startsWith("magnet:")) {
            payload.put("kind", "magnet");
            payload.put("url", url);
            notifyListeners("deepLink", payload);
        } else {
            try {
                InputStream in = getContext().getContentResolver().openInputStream(data);
                if (in != null) {
                    byte[] bytes = readAll(in);
                    in.close();
                    String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                    payload.put("kind", "torrent");
                    payload.put("torrentBase64", b64);
                    payload.put("name", data.getLastPathSegment());
                    notifyListeners("deepLink", payload);
                }
            } catch (Exception ignored) {
                // could not read torrent file
            }
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) != -1) {
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }
}
