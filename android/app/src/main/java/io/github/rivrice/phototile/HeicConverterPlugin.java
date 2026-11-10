package io.github.rivrice.phototile;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * HEIC/HEIF を Android 標準のデコーダー（端末メーカーがライセンスしたコーデック）で JPEG に変換する。
 * アプリ自体には HEVC デコーダーを同梱しない。
 */
@CapacitorPlugin(name = "HeicConverter")
public class HeicConverterPlugin extends Plugin {

    @PluginMethod
    public void toJpeg(PluginCall call) {
        final String data = call.getString("data");
        final int maxPixels = call.getInt("maxPixels", 16_000_000);
        if (data == null) {
            call.reject("データがありません");
            return;
        }
        new Thread(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                Bitmap bmp;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    ImageDecoder.Source src = ImageDecoder.createSource(ByteBuffer.wrap(bytes));
                    bmp = ImageDecoder.decodeBitmap(src, (decoder, info, source) -> {
                        decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                        int w = info.getSize().getWidth();
                        int h = info.getSize().getHeight();
                        long px = (long) w * h;
                        if (px > maxPixels) {
                            double k = Math.sqrt((double) maxPixels / px);
                            decoder.setTargetSize(Math.max(1, (int) (w * k)), Math.max(1, (int) (h * k)));
                        }
                    });
                } else {
                    bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                }
                if (bmp == null) {
                    call.reject("この端末ではHEICを読み込めませんでした");
                    return;
                }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.JPEG, 95, out);
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                ret.put("width", bmp.getWidth());
                ret.put("height", bmp.getHeight());
                bmp.recycle();
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("この端末ではHEICを読み込めませんでした: " + e.getMessage());
            }
        }).start();
    }
}
