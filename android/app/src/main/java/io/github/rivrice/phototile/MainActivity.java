package io.github.rivrice.phototile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HeicConverterPlugin.class);
        registerPlugin(ExifFrameLauncherPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
