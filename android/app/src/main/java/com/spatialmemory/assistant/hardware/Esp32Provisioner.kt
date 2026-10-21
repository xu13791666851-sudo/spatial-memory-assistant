package com.spatialmemory.assistant.hardware

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.random.Random

class Esp32Provisioner(private val context: Context) : DeviceProvisioner {
    private val mutableState = MutableStateFlow(ProvisionState.IDLE)
    private val devices = ConcurrentHashMap<String, ScanResult>()
    private var gatt: BluetoothGatt? = null
    override val state = mutableState.asStateFlow()

    @SuppressLint("MissingPermission")
    override suspend fun scan(): List<DeviceCandidate> {
        requireBlePermissions()
        val scanner = adapter().bluetoothLeScanner ?: error("蓝牙未开启")
        devices.clear()
        mutableState.value = ProvisionState.SCANNING
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) { devices[result.device.address] = result }
            override fun onBatchScanResults(results: MutableList<ScanResult>) { results.forEach { devices[it.device.address] = it } }
            override fun onScanFailed(errorCode: Int) { mutableState.value = ProvisionState.FAILED }
        }
        scanner.startScan(
            listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()),
            ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
            callback,
        )
        try { delay(5_000) } finally { scanner.stopScan(callback) }
        mutableState.value = ProvisionState.IDLE
        return devices.values.sortedByDescending { it.rssi }.map {
            DeviceCandidate(it.device.address, it.scanRecord?.deviceName ?: "视障相机", it.rssi)
        }
    }

    @SuppressLint("MissingPermission")
    override suspend fun provision(deviceId: String, ssid: String, password: CharArray): ProvisionResult {
        require(ssid.isNotBlank()) { "WiFi 名称不能为空" }
        require(password.isNotEmpty()) { "WiFi 密码不能为空" }
        val result = devices[deviceId] ?: return ProvisionResult.Failure("请先扫描并选择设备")
        mutableState.value = ProvisionState.CONNECTING
        val callback = ProvisionCallback()
        return try {
            val connected = result.device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE).also { gatt = it }
            withTimeout(10_000) { callback.ready.await() }
            connected.requestMtu(185)
            delay(300)
            writeChunks(connected, callback, SSID_UUID, ssid.toByteArray(Charsets.UTF_8))
            val passwordBytes = String(password).toByteArray(Charsets.UTF_8)
            try { writeChunks(connected, callback, PASSWORD_UUID, passwordBytes) } finally { passwordBytes.fill(0) }
            writeChunks(connected, callback, COMMAND_UUID, "commit".toByteArray())
            val network = readNetwork(connected, callback)
            check(network.optBoolean("connected") && network.optString("ip") != "0.0.0.0") {
                when (network.optInt("wifiStatus", -1)) {
                    1 -> "设备找不到该 WiFi，请确认名称正确且已开启 2.4 GHz"
                    4 -> "WiFi 认证失败，请检查密码或 WPA 认证方式"
                    else -> "设备未连上 WiFi，请检查密码与 2.4 GHz 网络"
                }
            }
            mutableState.value = ProvisionState.CONNECTED
            ProvisionResult.Success(network.optString("deviceId", deviceId), "http://${network.getString("ip")}", network.optString("token"))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            mutableState.value = ProvisionState.FAILED
            ProvisionResult.Failure(error.message ?: "BLE 配网失败")
        } finally {
            password.fill('\u0000')
            gatt?.disconnect(); gatt?.close(); gatt = null
        }
    }

    @SuppressLint("MissingPermission")
    private suspend fun readNetwork(gatt: BluetoothGatt, callback: ProvisionCallback): org.json.JSONObject {
        val characteristic = gatt.getService(SERVICE_UUID)?.getCharacteristic(NETWORK_UUID) ?: error("设备缺少网络信息")
        callback.nextRead = CompletableDeferred()
        check(gatt.readCharacteristic(characteristic)) { "无法读取设备网络信息" }
        return org.json.JSONObject(String(withTimeout(5_000) { callback.nextRead.await() }, Charsets.UTF_8))
    }

    @SuppressLint("MissingPermission")
    override suspend fun cancel() {
        gatt?.disconnect(); gatt?.close(); gatt = null
        mutableState.value = ProvisionState.IDLE
    }

    @SuppressLint("MissingPermission")
    private suspend fun writeChunks(gatt: BluetoothGatt, callback: ProvisionCallback, uuid: UUID, payload: ByteArray) {
        val characteristic = gatt.getService(SERVICE_UUID)?.getCharacteristic(uuid) ?: error("设备配网协议不完整")
        val requestId = Random.nextInt()
        val chunks = payload.asList().chunked(150)
        chunks.forEachIndexed { index, values ->
            val data = ByteBuffer.allocate(10 + values.size).order(ByteOrder.LITTLE_ENDIAN)
                .putInt(requestId).putShort(index.toShort()).putShort(chunks.size.toShort()).putShort(values.size.toShort())
                .put(values.toByteArray()).array()
            callback.nextWrite = CompletableDeferred()
            val accepted = if (Build.VERSION.SDK_INT >= 33) {
                gatt.writeCharacteristic(characteristic, data, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                characteristic.value = data
                @Suppress("DEPRECATION")
                gatt.writeCharacteristic(characteristic)
            }
            check(accepted) { "BLE 写入未被设备接受" }
            withTimeout(if (uuid == COMMAND_UUID) 25_000 else 5_000) { callback.nextWrite.await() }
        }
    }

    private fun adapter(): BluetoothAdapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter

    private fun requireBlePermissions() {
        val permissions = if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT) else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        check(permissions.all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }) { "请先授予附近设备权限" }
    }

    private class ProvisionCallback : BluetoothGattCallback() {
        val ready = CompletableDeferred<Unit>()
        var nextWrite = CompletableDeferred<Unit>()
        var nextRead = CompletableDeferred<ByteArray>()
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) ready.completeExceptionally(IllegalStateException("BLE 连接失败：$status"))
            else if (newState == BluetoothGatt.STATE_CONNECTED) gatt.discoverServices()
            else if (newState == BluetoothGatt.STATE_DISCONNECTED && !ready.isCompleted) ready.completeExceptionally(IllegalStateException("BLE 已断开"))
        }
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS && gatt.getService(SERVICE_UUID) != null) ready.complete(Unit)
            else ready.completeExceptionally(IllegalStateException("未发现视障相机配网服务"))
        }
        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) nextWrite.complete(Unit)
            else nextWrite.completeExceptionally(IllegalStateException("BLE 写入失败：$status"))
        }
        @Deprecated("Deprecated in Java")
        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            @Suppress("DEPRECATION")
            completeRead(characteristic.value ?: ByteArray(0), status)
        }
        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) = completeRead(value, status)
        private fun completeRead(value: ByteArray, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) nextRead.complete(value)
            else nextRead.completeExceptionally(IllegalStateException("BLE 读取失败：$status"))
        }
    }

    companion object {
        val SERVICE_UUID: UUID = UUID.fromString("62f10000-7a2e-4b79-9c81-a64e5532b001")
        val SSID_UUID: UUID = UUID.fromString("62f10002-7a2e-4b79-9c81-a64e5532b001")
        val PASSWORD_UUID: UUID = UUID.fromString("62f10003-7a2e-4b79-9c81-a64e5532b001")
        val COMMAND_UUID: UUID = UUID.fromString("62f10004-7a2e-4b79-9c81-a64e5532b001")
        val NETWORK_UUID: UUID = UUID.fromString("62f10006-7a2e-4b79-9c81-a64e5532b001")
    }
}
