package com.gongyou.guanjia;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.atomic.AtomicBoolean;

final class AsrHttpClient {
    static final String API_BASE = "http://23.26.204.65:8000";
    private static final int MAX_RESPONSE_BYTES = 256 * 1024;
    private volatile HttpURLConnection activeConnection;
    private volatile boolean closed;

    static final class Response {
        final int status;
        final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    static String endpoint(String language) {
        if ("hakka".equals(language)) return "/api/asr/hakka";
        if ("minnan".equals(language)) return "/api/asr/minnan";
        if ("mandarin".equals(language)) return "/api/asr";
        throw new IllegalArgumentException("unsupported_language");
    }

    Response recognize(String language, String json) throws IOException {
        Response result = post(new URL(API_BASE + endpoint(language)), json);
        if ("hakka".equals(language) && result.status == 404) {
            // The legacy route runs the same multilingual model; JS verifies its engine.
            result = post(new URL(API_BASE + "/api/asr/minnan"), json);
        }
        return result;
    }

    Response post(URL url, String json) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        synchronized (this) {
            if (closed) {
                connection.disconnect();
                throw new IOException("client_closed");
            }
            activeConnection = connection;
        }
        AtomicBoolean expired = new AtomicBoolean(false);
        Timer deadline = new Timer("asr-deadline", true);
        deadline.schedule(new TimerTask() {
            @Override
            public void run() {
                expired.set(true);
                connection.disconnect();
            }
        }, 70000);
        try {
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(60000);
            connection.setRequestMethod("POST");
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setDoOutput(true);
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) return new Response(status, "");
            try (InputStream input = connection.getInputStream();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (output.size() + read > MAX_RESPONSE_BYTES) {
                        throw new IOException("response_too_large");
                    }
                    output.write(buffer, 0, read);
                }
                return new Response(status, output.toString(StandardCharsets.UTF_8.name()));
            }
        } catch (IOException error) {
            if (expired.get()) throw new SocketTimeoutException("asr_timeout");
            throw error;
        } finally {
            deadline.cancel();
            connection.disconnect();
            synchronized (this) {
                if (activeConnection == connection) activeConnection = null;
            }
        }
    }

    synchronized void close() {
        closed = true;
        if (activeConnection != null) activeConnection.disconnect();
    }
}
