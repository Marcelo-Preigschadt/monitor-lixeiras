#include <SoftwareSerial.h>

// HC-SR04
constexpr uint8_t PIN_TRIG = 8;
constexpr uint8_t PIN_ECHO = 9;

// HC-05/HC-06: Arduino RX <- TX do módulo | Arduino TX -> RX do módulo
constexpr uint8_t PIN_BT_RX = 10;
constexpr uint8_t PIN_BT_TX = 11;
SoftwareSerial bluetooth(PIN_BT_RX, PIN_BT_TX);

// Ajuste conforme a lixeira real: distância do sensor até o fundo quando vazia.
constexpr float ALTURA_LIXEIRA_CM = 50.0f;
constexpr unsigned long INTERVALO_ENVIO_MS = 2000;

unsigned long ultimoEnvio = 0;

float medirDistanciaCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  const unsigned long duracao = pulseIn(PIN_ECHO, HIGH, 30000UL);
  if (duracao == 0) return NAN;

  return (duracao * 0.0343f) / 2.0f;
}

int calcularPercentual(float distanciaCm) {
  if (isnan(distanciaCm)) return -1;

  const float ocupadoCm = ALTURA_LIXEIRA_CM - distanciaCm;
  int percentual = (int)lround((ocupadoCm / ALTURA_LIXEIRA_CM) * 100.0f);

  if (percentual < 0) percentual = 0;
  if (percentual > 100) percentual = 100;
  return percentual;
}

void setup() {
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);

  Serial.begin(9600);
  bluetooth.begin(9600);
}

void loop() {
  if (millis() - ultimoEnvio < INTERVALO_ENVIO_MS) return;
  ultimoEnvio = millis();

  const float distancia = medirDistanciaCm();
  const int percentual = calcularPercentual(distancia);

  if (percentual < 0) {
    Serial.println(F("Falha na leitura do HC-SR04"));
    return;
  }

  // O aplicativo lê uma linha por vez usando delimitador LF (10).
  bluetooth.println(percentual);

  Serial.print(F("Distancia: "));
  Serial.print(distancia, 1);
  Serial.print(F(" cm | Ocupacao: "));
  Serial.print(percentual);
  Serial.println(F("%"));
}
