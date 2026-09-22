import base64
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location("gongyou_server", Path(__file__).parents[1] / "server" / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class DialectTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.audio = base64.b64encode(bytes(4096)).decode("ascii")
        self.secrets = patch.multiple(server, TENCENT_SECRET_ID="test", TENCENT_SECRET_KEY="test")
        self.secrets.start()
        self.addCleanup(self.secrets.stop)

    async def test_hakka_routes_to_multilingual_model(self):
        with patch.object(server, "tencent_asr_dialect", new_callable=AsyncMock, return_value="test transcript") as recognize:
            result = await server.asr(server.AsrRequest(audio_base64=self.audio, lang="hakka"))
        recognize.assert_awaited_once_with(bytes(4096), "wav", "hakka")
        self.assertEqual(result["mode"], "hakka")
        self.assertIn(result["engine"], {"16k_zh_en", "16k_zh_en_2.0"})

    async def test_hakka_endpoint_forces_hakka_mode(self):
        with patch.object(server, "tencent_asr_dialect", new_callable=AsyncMock, return_value="test") as recognize:
            await server.asr_hakka(server.AsrRequest(audio_base64=self.audio, lang="mandarin"))
        self.assertEqual(recognize.await_args.args[2], "hakka")

    async def test_mandarin_keeps_sentence_engine(self):
        with patch.object(server, "tencent_asr_sentence", new_callable=AsyncMock, return_value="test") as recognize:
            result = await server.asr(server.AsrRequest(audio_base64=self.audio, lang="mandarin"))
        self.assertEqual(result["engine"], "16k_zh")
        recognize.assert_awaited_once()

    async def test_hakka_task_uses_configured_engine(self):
        responses = [{"Response": {"Data": {"TaskId": 1}}}, {"Response": {"Data": {"Status": 2, "Result": "test"}}}]
        with patch.object(server, "_tencent_asr_request", new_callable=AsyncMock, side_effect=responses) as request:
            with patch("asyncio.sleep", new_callable=AsyncMock):
                result = await server.tencent_asr_dialect(bytes(4096), "wav", "hakka")
        self.assertEqual(result, "test")
        self.assertEqual(request.await_args_list[0].args[1]["EngineModelType"], server.TENCENT_ASR_HAKKA_ENGINE)

    async def test_unknown_language_is_not_silently_replaced(self):
        result = await server.asr(server.AsrRequest(audio_base64=self.audio, lang="unknown"))
        self.assertEqual(result["text"], "")
        self.assertTrue(result["error"])


if __name__ == "__main__":
    unittest.main()
