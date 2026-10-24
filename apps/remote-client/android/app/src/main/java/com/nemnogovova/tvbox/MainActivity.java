package com.nemnogovova.tvbox;

import android.content.Intent;
import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private TvboxNativePlugin nativePlugin;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TvboxNativePlugin.class);
        super.onCreate(savedInstanceState);
        nativePlugin = (TvboxNativePlugin) getBridge().getPlugin("TvboxNative").getInstance();
        if (nativePlugin != null) {
            nativePlugin.handleIntent(getIntent());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (nativePlugin != null) {
            nativePlugin.handleIntent(intent);
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (nativePlugin != null && nativePlugin.dispatchKeyEvent(event)) {
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}
