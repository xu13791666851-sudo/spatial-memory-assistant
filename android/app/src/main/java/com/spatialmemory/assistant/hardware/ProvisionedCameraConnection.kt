package com.spatialmemory.assistant.hardware

import java.net.URI

/** The supplied app_httpd.cpp serves control on port 80 and MJPEG on port 81. */
fun ProvisionResult.Success.cameraConnection(): Esp32Connection {
    val base = URI(baseUrl.trimEnd('/'))
    require(base.scheme == "http" && !base.host.isNullOrBlank()) { "设备返回的网络地址无效" }
    val stream = URI(base.scheme, null, base.host, 81, "/stream", null, null).toString()
    return Esp32Connection(base.toString(), stream, deviceId, token)
}
