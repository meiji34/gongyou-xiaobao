package com.gongyou.guanjia;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.annotation.RequiresApi;
import java.io.IOException;
import java.io.OutputStream;

final class EvidenceImageStore {
    static byte[] decode(String dataUrl) throws IOException {
        if (dataUrl == null || !dataUrl.startsWith("data:image/png;base64,") || dataUrl.length() > 22000000) {
            throw new IOException("invalid_image");
        }
        byte[] bytes;
        try { bytes = Base64.decode(dataUrl.substring(22), Base64.DEFAULT); }
        catch (IllegalArgumentException error) { throw new IOException("invalid_image", error); }
        if (bytes.length < 8 || bytes[0] != (byte) 137 || bytes[1] != 80 || bytes[2] != 78 || bytes[3] != 71) {
            throw new IOException("invalid_image");
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (options.outWidth <= 0 || options.outHeight <= 0 || (long) options.outWidth * options.outHeight > 16000000) {
            throw new IOException("invalid_image");
        }
        return bytes;
    }

    static String filename(String name) {
        if (name != null && name.matches("work-records-[0-9]+-(?:[0-9]+|contract)\\.png")) return name;
        return "work-records-" + System.currentTimeMillis() + ".png";
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    static void saveToGallery(ContentResolver resolver, byte[] bytes, String filename) throws IOException {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, filename);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/GongyouXiaobao");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("create_image_failed");
        try {
            write(resolver, uri, bytes);
            values.clear();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            if (resolver.update(uri, values, null, null) != 1) throw new IOException("publish_image_failed");
        } catch (Exception error) {
            // Roll back only the unpublished image created by this operation.
            try { resolver.delete(uri, null, null); } catch (Exception ignored) {}
            throw new IOException("save_image_failed", error);
        }
    }

    static void write(ContentResolver resolver, Uri uri, byte[] bytes) throws IOException {
        try (OutputStream output = resolver.openOutputStream(uri, "wt")) {
            if (output == null) throw new IOException("open_image_failed");
            output.write(bytes);
            output.flush();
        }
    }
}
