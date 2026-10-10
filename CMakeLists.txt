cmake_minimum_required(VERSION 3.28)
project(crx CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

FetchContent_Declare(json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz)
FetchContent_Declare(doctest
  URL https://github.com/doctest/doctest/archive/refs/tags/v2.4.12.tar.gz)
FetchContent_MakeAvailable(json doctest)

add_library(crx_engine STATIC
  engine/src/api.cpp
  engine/src/catalog/catalog.cpp
  engine/src/sim/adaptation.cpp
  engine/src/sim/control.cpp
  engine/src/sim/dispatch.cpp
  engine/src/sim/events.cpp
  engine/src/sim/pipelines.cpp
  engine/src/sim/production.cpp
  engine/src/sim/procurement.cpp
  engine/src/sim/recorder.cpp
  engine/src/sim/routes.cpp
  engine/src/sim/signals.cpp
  engine/src/sim/sim.cpp
  engine/src/sim/sixsite.cpp
  engine/src/sim/validate.cpp
  engine/src/sim/world.cpp)
target_include_directories(crx_engine PUBLIC engine/include engine/src)
target_compile_definitions(crx_engine PRIVATE
  CRX_DATA_DIR="${CMAKE_SOURCE_DIR}/engine/data/catalog")
target_link_libraries(crx_engine PUBLIC nlohmann_json::nlohmann_json)
target_compile_options(crx_engine PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-ffp-contract=off -Wall -Wextra -Wpedantic>)

add_executable(crx-cli engine/apps/cli/main.cpp)
target_link_libraries(crx-cli PRIVATE crx_engine)

enable_testing()
add_executable(crx_tests engine/tests/test_core.cpp)
target_link_libraries(crx_tests PRIVATE crx_engine doctest::doctest)
add_test(NAME core COMMAND crx_tests)

add_executable(crx_sim_tests engine/tests/test_sim.cpp)
target_link_libraries(crx_sim_tests PRIVATE crx_engine doctest::doctest)
add_test(NAME sim COMMAND crx_sim_tests)

add_executable(crx_logistics_tests engine/tests/test_logistics.cpp)
target_link_libraries(crx_logistics_tests PRIVATE crx_engine doctest::doctest)
add_test(NAME logistics COMMAND crx_logistics_tests)

# ---- crx-server: HTTP host over the C ABI (§7.4) ----
FetchContent_Declare(httplib
  URL https://github.com/yhirose/cpp-httplib/archive/refs/tags/v0.18.7.tar.gz)
FetchContent_MakeAvailable(httplib)

add_library(crx_server_core STATIC
  apps/server/crx_server.cpp)
target_include_directories(crx_server_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/apps/server)
target_link_libraries(crx_server_core PUBLIC crx_engine httplib::httplib)
target_compile_options(crx_server_core PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic>)

add_executable(crx-server apps/server/main.cpp)
target_link_libraries(crx-server PRIVATE crx_server_core)

add_executable(crx_server_tests apps/server/tests/test_server.cpp)
target_link_libraries(crx_server_tests PRIVATE crx_server_core doctest::doctest)
add_test(NAME server COMMAND crx_server_tests)

add_executable(crx_catalog_tests engine/tests/test_catalog.cpp)
target_link_libraries(crx_catalog_tests PRIVATE crx_engine doctest::doctest)
target_compile_definitions(crx_catalog_tests PRIVATE
  CRX_CATALOG_DIR="${CMAKE_SOURCE_DIR}/engine/data/catalog")
add_test(NAME catalog COMMAND crx_catalog_tests)

# ---- crx-worldgen: template layout generator (§6) ----
add_library(crx_worldgen STATIC
  engine/src/world/worldgen/CatalogData.cpp
  engine/src/world/worldgen/Geo.cpp
  engine/src/world/worldgen/Layout.cpp
  engine/src/world/worldgen/Routes.cpp
  engine/src/world/worldgen/Sizing.cpp
  engine/src/world/worldgen/Feasibility.cpp
  engine/src/world/worldgen/WorldJson.cpp
  engine/src/world/worldgen/WorldGen.cpp)
target_include_directories(crx_worldgen PUBLIC engine/src)
target_link_libraries(crx_worldgen PUBLIC crx_engine nlohmann_json::nlohmann_json)
target_compile_options(crx_worldgen PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-ffp-contract=off -Wall -Wextra -Wpedantic>)

add_executable(crx_worldgen_tests engine/tests/test_worldgen.cpp)
target_link_libraries(crx_worldgen_tests PRIVATE crx_worldgen doctest::doctest)
add_test(NAME worldgen COMMAND crx_worldgen_tests)

target_link_libraries(crx-cli PRIVATE crx_worldgen)
