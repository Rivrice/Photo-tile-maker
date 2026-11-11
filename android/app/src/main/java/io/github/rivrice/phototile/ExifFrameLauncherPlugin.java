package io.github.rivrice.phototile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;

/**
 * 書き出した画像を Exif Frame Maker アプリ（io.github.rivrice.exifframe）に渡して開く。
 * アプリが入っていなければ、ダウンロードページ（GitHub Releases）を開く。
 */
@CapacitorPlugin(name = "ExifFrameLauncher")
public class ExifFrameLauncherPlugin extends Plugin {
    static final String EFM_PACKAGE = "io.github.rivrice.exifframe";
    static final String EFM_RELEASES = "https://github.com/Rivrice/exif-frame-maker/releases/latest";

    @PluginMethod
    public void open(PluginCall call) {
        String data = call.getString("data");
        String name = call.getString("name", "photo-tile.jpg");
        if (data == null) {
            call.reject("データがありません");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), "efm");
            if (!dir.exists()) dir.mkdirs();
            // 前回渡したファイルは消しておく
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete();
            File file = new File(dir, name.replaceAll("[^A-Za-z0-9._-]", "_"));
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(Base64.decode(data, Base64.DEFAULT));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setPackage(EFM_PACKAGE);
            intent.setType("image/jpeg");
            intent.putExtra(Intent.EXTRA_STREAM, uri);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            JSObject ret = new JSObject();
            try {
                getActivity().startActivity(intent);
                ret.put("opened", true);
            } catch (ActivityNotFoundException e) {
                Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(EFM_RELEASES));
                view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    getActivity().startActivity(view);
                } catch (ActivityNotFoundException ignored) {
                    // ブラウザも無い
                }
                ret.put("opened", false);
            }
            call.resolve(ret);
        } catch (Throwable e) {
            call.reject("Exif Frame Maker を開けませんでした: " + e.getMessage());
        }
    }
}
