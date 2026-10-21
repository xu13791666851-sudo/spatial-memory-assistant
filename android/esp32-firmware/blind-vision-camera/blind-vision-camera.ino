#include <Arduino.h>
#include "esp_camera.h"
#include <WiFi.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include "board_config.h"

static const char *SERVICE_UUID = "62f10000-7a2e-4b79-9c81-a64e5532b001";
static const char *DEVICE_INFO_UUID = "62f10001-7a2e-4b79-9c81-a64e5532b001";
static const char *SSID_UUID = "62f10002-7a2e-4b79-9c81-a64e5532b001";
static const char *PASSWORD_UUID = "62f10003-7a2e-4b79-9c81-a64e5532b001";
static const char *COMMAND_UUID = "62f10004-7a2e-4b79-9c81-a64e5532b001";
static const char *NETWORK_UUID = "62f10006-7a2e-4b79-9c81-a64e5532b001";

Preferences preferences;
String pendingSsid, pendingPassword, deviceId, deviceToken;
bool serverStarted = false;
bool cameraStreamingEnabled = false;
bool provisioningOpen = true;
BLECharacteristic *networkCharacteristic = nullptr;

void startCameraServer();
void setupLedFlash();

const char *stageBDeviceId() { return deviceId.c_str(); }
const char *stageBDeviceToken() { return deviceToken.c_str(); }
bool stageBCameraEnabled() { return cameraStreamingEnabled; }
void stageBSetCameraEnabled(bool value) { cameraStreamingEnabled = value; }

String randomHex(size_t bytes) {
  static const char *hex = "0123456789abcdef";
  String value;
  value.reserve(bytes * 2);
  for (size_t i = 0; i < bytes; ++i) {
    uint8_t v = esp_random() & 0xff;
    value += hex[v >> 4]; value += hex[v & 0xf];
  }
  return value;
}

void updateNetworkInfo() {
  if (!networkCharacteristic) return;
  String json = "{\"deviceId\":\"" + deviceId + "\",\"connected\":" + (WiFi.status() == WL_CONNECTED ? "true" : "false") + ",\"wifiStatus\":" + String((int)WiFi.status()) + ",\"ip\":\"" + WiFi.localIP().toString() + "\",\"token\":\"" + deviceToken + "\"}";
  networkCharacteristic->setValue(json.c_str());
  networkCharacteristic->notify();
}

bool connectWifi(const String &ssid, const String &password) {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(ssid.c_str(), password.c_str());
  unsigned long deadline = millis() + 15000;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) delay(250);
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("WIFI_FAILED status=%d\n", (int)WiFi.status());
    updateNetworkInfo();
    return false;
  }
  if (!serverStarted) { startCameraServer(); serverStarted = true; }
  updateNetworkInfo();
  Serial.printf("ONLINE ip=%s device=%s\n", WiFi.localIP().toString().c_str(), deviceId.c_str());
  return true;
}

struct ChunkBuffer {
  uint32_t requestId = 0;
  uint16_t next = 0;
  uint16_t total = 0;
  String value;
  bool append(const String &packet) {
    if (packet.length() < 10) return false;
    const uint8_t *p = reinterpret_cast<const uint8_t *>(packet.c_str());
    uint32_t id = p[0] | p[1] << 8 | p[2] << 16 | p[3] << 24;
    uint16_t sequence = p[4] | p[5] << 8;
    uint16_t count = p[6] | p[7] << 8;
    uint16_t length = p[8] | p[9] << 8;
    if (packet.length() != size_t(10 + length) || count == 0 || sequence >= count) return false;
    if (sequence == 0) { requestId = id; next = 0; total = count; value = ""; }
    if (id != requestId || sequence != next || count != total) return false;
    value.concat(packet.c_str() + 10, length); next++;
    return next == total;
  }
};

ChunkBuffer ssidChunks, passwordChunks, commandChunks;

class ProvisionWriteCallback : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    if (!provisioningOpen) return;
    const String packet = characteristic->getValue();
    const String uuid = characteristic->getUUID().toString().c_str();
    if (uuid.equalsIgnoreCase(SSID_UUID) && ssidChunks.append(packet)) pendingSsid = ssidChunks.value;
    else if (uuid.equalsIgnoreCase(PASSWORD_UUID) && passwordChunks.append(packet)) pendingPassword = passwordChunks.value;
    else if (uuid.equalsIgnoreCase(COMMAND_UUID) && commandChunks.append(packet) && commandChunks.value == "commit") {
      if (pendingSsid.length() && pendingPassword.length() && connectWifi(pendingSsid, pendingPassword)) {
        preferences.putString("ssid", pendingSsid);
        preferences.putString("password", pendingPassword);
        provisioningOpen = false;
        updateNetworkInfo();
      }
      pendingPassword = "";
    }
  }
};

void startBleProvisioning() {
  BLEDevice::init(("BV-CAMERA-" + deviceId.substring(deviceId.length() - 4)).c_str());
  BLESecurity::setAuthenticationMode(true, false, true);
  BLESecurity::setCapability(ESP_IO_CAP_NONE);
  BLESecurity::setKeySize(16);
  BLEServer *server = BLEDevice::createServer();
  BLEService *service = server->createService(SERVICE_UUID);
  BLECharacteristic *info = service->createCharacteristic(DEVICE_INFO_UUID, BLECharacteristic::PROPERTY_READ);
  info->setValue(("{\"deviceId\":\"" + deviceId + "\",\"firmware\":\"0.2.0\"}").c_str());
  ProvisionWriteCallback *writer = new ProvisionWriteCallback();
  BLECharacteristic *ssid = service->createCharacteristic(SSID_UUID, BLECharacteristic::PROPERTY_WRITE);
  BLECharacteristic *password = service->createCharacteristic(PASSWORD_UUID, BLECharacteristic::PROPERTY_WRITE);
  BLECharacteristic *command = service->createCharacteristic(COMMAND_UUID, BLECharacteristic::PROPERTY_WRITE);
  ssid->setCallbacks(writer); password->setCallbacks(writer); command->setCallbacks(writer);
  ssid->setAccessPermissions(ESP_GATT_PERM_WRITE_ENCRYPTED);
  password->setAccessPermissions(ESP_GATT_PERM_WRITE_ENCRYPTED);
  command->setAccessPermissions(ESP_GATT_PERM_WRITE_ENCRYPTED);
  networkCharacteristic = service->createCharacteristic(NETWORK_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  networkCharacteristic->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED);
  service->start();
  updateNetworkInfo();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->start();
}

bool initCamera() {
  camera_config_t config{};
  config.ledc_channel = LEDC_CHANNEL_0; config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM; config.pin_d1 = Y3_GPIO_NUM; config.pin_d2 = Y4_GPIO_NUM; config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM; config.pin_d5 = Y7_GPIO_NUM; config.pin_d6 = Y8_GPIO_NUM; config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM; config.pin_pclk = PCLK_GPIO_NUM; config.pin_vsync = VSYNC_GPIO_NUM; config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM; config.pin_sccb_scl = SIOC_GPIO_NUM; config.pin_pwdn = PWDN_GPIO_NUM; config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000; config.pixel_format = PIXFORMAT_JPEG; config.frame_size = FRAMESIZE_VGA;
  config.grab_mode = CAMERA_GRAB_LATEST; config.fb_location = CAMERA_FB_IN_PSRAM; config.jpeg_quality = 12; config.fb_count = psramFound() ? 2 : 1;
  if (esp_camera_init(&config) != ESP_OK) return false;
  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor->id.PID == OV3660_PID) { sensor->set_vflip(sensor, 1); sensor->set_brightness(sensor, 1); sensor->set_saturation(sensor, -2); }
  return true;
}

void setup() {
  Serial.begin(115200);
  preferences.begin("blind-camera", false);
  pinMode(0, INPUT_PULLUP);
  delay(80);
  if (digitalRead(0) == LOW) { preferences.remove("ssid"); preferences.remove("password"); }
  uint64_t mac = ESP.getEfuseMac();
  deviceId = "bv-" + String((uint32_t)(mac & 0xffffff), HEX);
  deviceToken = preferences.getString("token", "");
  if (!deviceToken.length()) { deviceToken = randomHex(16); preferences.putString("token", deviceToken); }
  Serial.printf("chip=%s flash=%u psram=%u device=%s\n", ESP.getChipModel(), ESP.getFlashChipSize(), ESP.getPsramSize(), deviceId.c_str());
  if (!initCamera()) { Serial.println("CAMERA_INIT_FAILED"); return; }
  String ssid = preferences.getString("ssid", "");
  provisioningOpen = ssid.isEmpty();
  startBleProvisioning();
  String password = preferences.getString("password", "");
  if (ssid.length()) connectWifi(ssid, password);
  password = "";
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    String ssid = preferences.getString("ssid", "");
    String password = preferences.getString("password", "");
    if (ssid.length()) connectWifi(ssid, password);
    password = "";
  }
  delay(5000);
}
