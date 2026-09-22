package com.gongyou.guanjia;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

public final class AsrHttpClientTest {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        check(AsrHttpClient.endpoint("hakka").equals("/api/asr/hakka"), "hakka endpoint");
        check(AsrHttpClient.endpoint("minnan").equals("/api/asr/minnan"), "minnan endpoint");
        check(AsrHttpClient.endpoint("mandarin").equals("/api/asr"), "mandarin endpoint");
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<String> uploaded = new AtomicReference<>();
        AtomicReference<String> contentType = new AtomicReference<>();
        server.createContext("/ok", exchange -> {
            uploaded.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
            byte[] body = "{\"text\":\"test transcript\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.createContext("/failed", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(503, -1);
            exchange.close();
        });
        server.createContext("/redirect", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().set("Location", "/ok");
            exchange.sendResponseHeaders(302, -1);
            exchange.close();
        });
        server.createContext("/large", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] body = new byte[262145];
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        AsrHttpClient client = new AsrHttpClient();
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        try {
            AsrHttpClient.Response result = client.post(new URL(base + "/ok"), "{\"audio_base64\":\"test\"}");
            check(result.status == 200 && result.body.contains("test transcript"), "successful response");
            check(uploaded.get().contains("audio_base64"), "request body");
            check(contentType.get().equals("application/json; charset=UTF-8"), "content type");
            check(client.post(new URL(base + "/failed"), "{}").status == 503, "preserve HTTP status");
            check(client.post(new URL(base + "/redirect"), "{}").status == 302, "do not forward audio to redirects");
            try {
                client.post(new URL(base + "/large"), "{}");
                throw new AssertionError("oversized response accepted");
            } catch (java.io.IOException expected) {
                check(expected.getMessage().equals("response_too_large"), "response size bound");
            }
            client.close();
            try {
                client.post(new URL(base + "/ok"), "{}");
                throw new AssertionError("closed client accepted request");
            } catch (java.io.IOException expected) {
                check(expected.getMessage().equals("client_closed"), "closed client");
            }
            System.out.println("AsrHttpClient: success, upload body, status, redirect, size limit, lifecycle passed");
        } finally {
            client.close();
            server.stop(0);
        }
    }
}
