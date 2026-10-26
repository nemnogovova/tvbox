package com.nemnogovova.tvbox;

import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TvboxNativePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (TvboxNativePlugin.handleKey(event)) return true;
        return super.dispatchKeyEvent(event);
    }
}
