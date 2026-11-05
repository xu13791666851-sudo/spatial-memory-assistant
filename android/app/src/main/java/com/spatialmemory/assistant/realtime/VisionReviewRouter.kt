package com.spatialmemory.assistant.realtime

import android.content.Context
import com.spatialmemory.assistant.camera.FramePacket
import com.spatialmemory.assistant.security.JevKeyStore

/** Fixed architecture: Qwen converses; independent OpenRouter Jev reviews pixels. */
class VisionReviewRouter(context: Context) : ImageVerifier {
    private val store = JevKeyStore(context, provider = JevProvider.OPENROUTER)
    private val verifier = JevDirectVerifier(store::read, provider = JevProvider.OPENROUTER)
    override suspend fun verify(fullFrame: FramePacket, cropFrame: FramePacket?, request: CandidateVerificationRequest, references: List<ByteArray>): ImageReview {
        return if (!store.isVerified()) ImageReview(ImageDecision.UNCERTAIN, null, "图片确认暂未就绪，请稍后重试")
            else verifier.verify(fullFrame, cropFrame, request, references)
    }
}
