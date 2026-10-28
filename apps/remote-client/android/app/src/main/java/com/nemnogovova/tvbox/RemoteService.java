package com.nemnogovova.tvbox;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.media.VolumeProviderCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Keeps the TV under control while the phone screen is off or the app is in background:
 *  - a media notification (previous / play-pause / next / stop) and lock-screen controls,
 *  - hardware volume keys change the TV volume (remote-playback MediaSession),
 * talking to the TVBox server over plain HTTPS (/api/player, /api/control), so it keeps
 * working while the WebView (and its websocket) is suspended by Android.
 */
public class RemoteService extends Service {
    private static final String TAG = "TvboxRemote";
    private static final String CHANNEL = "tvbox_remote";
    private static final int NOTIFICATION_ID = 7301;
    static final String PREFS = "tvbox_remote";
    static final String ACTION_START = "com.nemnogovova.tvbox.START";
    static final String ACTION_STOP = "com.nemnogovova.tvbox.STOP";
    private static final String ACTION_CMD = "com.nemnogovova.tvbox.CMD";

    private HandlerThread thread;
    private Handler worker;
    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaSessionCompat session;
    private VolumeProviderCompat volumeProvider;

    private String server = "";
    private String token = "";
    private boolean running = false;

    // last known state
    private String status = "idle";
    private String source = "none";
    private String title = "";
    private String subtitle = "";
    private String posterUrl = null;
    private Bitmap poster = null;
    private double position = 0;
    private double duration = 0;
    private int volume = 50;
    private boolean muted = false;
    private boolean tvOnline = false;
    private long lastVolumeCmd = 0;
    /** Latest volume asked with the keys, not sent yet (-1: nothing pending). Steps are merged into one request. */
    private volatile int pendingVolume = -1;
    private static volatile RemoteService current;

    /** The "phone volume keys control the TV" setting changed in the app. */
    static void applyVolumeKeys(boolean enabled) {
        RemoteService s = current;
        if (s != null) s.main.post(() -> s.setVolumeRouting(enabled));
    }

    /** Volume keys: TV volume (remote playback) or the phone's own media volume. */
    private void setVolumeRouting(boolean tv) {
        if (session == null) return;
        if (tv) session.setPlaybackToRemote(volumeProvider);
        else session.setPlaybackToLocal(AudioManager.STREAM_MUSIC);
    }

    static void start(Context ctx, String server, String token) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("server", server).putString("token", token).putBoolean("enabled", true).apply();
        Intent i = new Intent(ctx, RemoteService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    static void stop(Context ctx) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
        ctx.stopService(new Intent(ctx, RemoteService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        thread = new HandlerThread("tvbox-remote");
        thread.start();
        worker = new Handler(thread.getLooper());
        createChannel();

        session = new MediaSessionCompat(this, "TVBox");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { send("{\"type\":\"PLAY_PAUSE\"}"); }
            @Override public void onPause() { send("{\"type\":\"PLAY_PAUSE\"}"); }
            @Override public void onSkipToNext() { send("{\"type\":\"NEXT\"}"); }
            @Override public void onSkipToPrevious() { send("{\"type\":\"PREVIOUS\"}"); }
            @Override public void onStop() { send("{\"type\":\"STOP\"}"); }
            @Override public void onSeekTo(long pos) { send("{\"type\":\"SEEK\",\"position\":" + (pos / 1000.0) + "}"); }
            @Override public void onFastForward() { send("{\"type\":\"SEEK_RELATIVE\",\"delta\":10}"); }
            @Override public void onRewind() { send("{\"type\":\"SEEK_RELATIVE\",\"delta\":-10}"); }
        });
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        session.setSessionActivity(PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));

        // Hardware volume keys -> TV volume (works on the lock screen too)
        volumeProvider = new VolumeProviderCompat(VolumeProviderCompat.VOLUME_CONTROL_ABSOLUTE, 100, volume) {
            @Override
            public void onAdjustVolume(int direction) {
                if (direction == 0) return;
                int next = Math.max(0, Math.min(100, getCurrentVolume() + direction * 5));
                setCurrentVolume(next);
                volume = next;
                lastVolumeCmd = System.currentTimeMillis();
                sendVolume(next);
            }

            @Override
            public void onSetVolumeTo(int value) {
                setCurrentVolume(value);
                volume = value;
                lastVolumeCmd = System.currentTimeMillis();
                sendVolume(value);
            }
        };
        setVolumeRouting(getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("volumeKeys", true));
        session.setActive(true);
        current = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_CMD.equals(action) && intent.getStringExtra("cmd") != null) {
            send(intent.getStringExtra("cmd"));
        }
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        server = p.getString("server", "");
        token = p.getString("token", "");
        if (!p.getBoolean("enabled", false) || server.isEmpty() || token.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startInForeground();
        if (!running) {
            running = true;
            worker.post(poll);
        }
        return START_STICKY;
    }

    private void startInForeground() {
        Notification n = buildNotification();
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type);
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed", e);
            stopSelf();
        }
    }

    // ------------------------------------------------------------------ polling
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            fetchState();
            boolean playing = "playing".equals(status) || "loading".equals(status);
            worker.postDelayed(this, playing ? 2500 : 8000);
        }
    };

    private void fetchState() {
        try {
            JSONObject body = http("GET", "/api/player", null);
            if (body == null) return;
            JSONObject presence = body.optJSONObject("presence");
            tvOnline = presence != null && presence.optBoolean("tvConnected", false);
            JSONObject d = body.optJSONObject("data");
            if (d != null) {
                status = d.optString("status", "idle");
                source = d.optString("source", "none");
                title = d.optString("title", "");
                String artist = d.optString("artist", "");
                subtitle = !artist.isEmpty() ? artist : d.optString("subtitle", "");
                position = d.optDouble("position", 0);
                duration = d.optDouble("duration", 0);
                if (System.currentTimeMillis() - lastVolumeCmd > 2500) {
                    volume = (int) Math.round(d.optDouble("volume", 0.5) * 100);
                    muted = d.optBoolean("muted", false);
                }
                String newPoster = d.optString("poster", "");
                if (newPoster.isEmpty() || newPoster.startsWith("music-cover:")) newPoster = null;
                if (newPoster == null ? posterUrl != null : !newPoster.equals(posterUrl)) {
                    posterUrl = newPoster;
                    poster = newPoster != null ? loadBitmap(newPoster) : null;
                }
            }
            main.post(this::publish);
        } catch (Exception e) {
            Log.w(TAG, "poll failed: " + e.getMessage());
        }
    }

    /**
     * Volume keys pressed in a row: one request with the latest absolute volume instead of
     * a queue of steps (each step was its own HTTPS request, so the TV lagged far behind).
     */
    private void sendVolume(int value) {
        pendingVolume = value;
        worker.post(() -> {
            int v = pendingVolume;
            if (v < 0) return;
            pendingVolume = -1;
            try {
                http("POST", "/api/control", "{\"type\":\"VOLUME\",\"volume\":" + (v / 100.0) + "}");
            } catch (Exception e) {
                Log.w(TAG, "volume failed: " + e.getMessage());
            }
            if (pendingVolume < 0) {
                worker.removeCallbacks(fetchLater);
                worker.postDelayed(fetchLater, 2600);
            }
        });
    }

    private final Runnable fetchLater = this::fetchState;

    private void send(String json) {
        worker.post(() -> {
            try {
                http("POST", "/api/control", json);
            } catch (Exception e) {
                Log.w(TAG, "control failed: " + e.getMessage());
            }
            worker.postDelayed(this::fetchState, 400);
        });
    }

    @Nullable
    private JSONObject http(String method, String path, @Nullable String json) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(server + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(8000);
        c.setReadTimeout(12000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        if (json != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = c.getOutputStream()) {
                os.write(json.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = c.getResponseCode();
        if (code == 401) {
            // signed out / token revoked
            main.post(() -> {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
                stopSelf();
            });
            return null;
        }
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (in == null) return null;
        // no disconnect(): the connection stays in the keep-alive pool, the next command skips the TLS handshake
        String text = readAll(in);
        return new JSONObject(text);
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    @Nullable
    private Bitmap loadBitmap(String url) {
        try {
            if (url.startsWith("data:")) {
                byte[] bytes = Base64.decode(url.substring(url.indexOf(',') + 1), Base64.DEFAULT);
                return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            }
            if (!url.startsWith("http")) return null;
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(8000);
            try (InputStream in = c.getInputStream()) {
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inSampleSize = 2;
                return BitmapFactory.decodeStream(in, null, o);
            }
        } catch (Exception e) {
            return null;
        }
    }

    // ------------------------------------------------------------------ UI
    private void publish() {
        if (!running) return;
        boolean idle = "none".equals(source) || "idle".equals(status);
        String t = !tvOnline ? "Телевизор не в сети" : idle ? "TVBox" : (title.isEmpty() ? "Без названия" : title);
        String sub = !tvOnline ? "Откройте TVBox на ТВ" : idle ? "Ничего не играет" : subtitle;

        MediaMetadataCompat.Builder meta = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, t)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, sub)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (long) (duration * 1000));
        if (poster != null) meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, poster);
        session.setMetadata(meta.build());

        int state = "playing".equals(status) ? PlaybackStateCompat.STATE_PLAYING
                : "paused".equals(status) ? PlaybackStateCompat.STATE_PAUSED
                : "loading".equals(status) ? PlaybackStateCompat.STATE_BUFFERING
                : PlaybackStateCompat.STATE_STOPPED;
        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                        | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackStateCompat.ACTION_STOP | PlaybackStateCompat.ACTION_SEEK_TO
                        | PlaybackStateCompat.ACTION_FAST_FORWARD | PlaybackStateCompat.ACTION_REWIND)
                .setState(state, (long) (position * 1000), "playing".equals(status) ? 1f : 0f)
                .build());
        volumeProvider.setCurrentVolume(muted ? 0 : volume);

        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.notify(NOTIFICATION_ID, buildNotification());
    }

    private PendingIntent cmdIntent(int req, String json) {
        Intent i = new Intent(this, RemoteService.class).setAction(ACTION_CMD).putExtra("cmd", json);
        return PendingIntent.getService(this, req, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildNotification() {
        boolean playing = "playing".equals(status);
        boolean idle = "none".equals(source) || "idle".equals(status);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stopService = PendingIntent.getService(this, 9, new Intent(this, RemoteService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(!tvOnline ? "Телевизор не в сети" : idle ? "TVBox — пульт" : title)
                .setContentText(!tvOnline ? "Откройте TVBox на ТВ" : idle ? "Кнопки громкости управляют телевизором" : subtitle)
                .setContentIntent(content)
                .setDeleteIntent(stopService)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setSilent(true)
                .setOngoing(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT);
        if (poster != null) b.setLargeIcon(poster);

        b.addAction(android.R.drawable.ic_media_previous, "Назад", cmdIntent(1, "{\"type\":\"PREVIOUS\"}"));
        b.addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing ? "Пауза" : "Играть", cmdIntent(2, "{\"type\":\"PLAY_PAUSE\"}"));
        b.addAction(android.R.drawable.ic_media_next, "Далее", cmdIntent(3, "{\"type\":\"NEXT\"}"));
        b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Отключить", stopService);
        b.setStyle(new MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2).setShowCancelButton(true).setCancelButtonIntent(stopService));
        return b.build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Пульт TVBox", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Управление телевизором при выключенном экране");
        ch.setShowBadge(false);
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
    }

    @Override
    public void onDestroy() {
        if (current == this) current = null;
        running = false;
        worker.removeCallbacksAndMessages(null);
        thread.quitSafely();
        session.setActive(false);
        session.release();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
