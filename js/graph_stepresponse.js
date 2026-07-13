"use strict";

function FlightLogStepResponse(flightLog, canvas, stepResponseCanvas) {

const
        STEP_RESPONSE_LARGE_LEFT_MARGIN    = 10,
        STEP_RESPONSE_LARGE_TOP_MARGIN     = 10,
        STEP_RESPONSE_LARGE_HEIGHT_MARGIN  = 20,
        STEP_RESPONSE_LARGE_WIDTH_MARGIN   = 20,

        STEP_RESPONSE_DEFAULT_POSITION = {
            left  : '60%',
            top   : '60%',
            size  : '35%',
        };

var
    that = this,

    isFullscreen = false,

    dataReload = true,

    stepResponseData = null,

    prefs = new PrefStorage();

    try {

        StepResponseCalc.initialize(flightLog, flightLog.getSysConfig());
        StepResponsePlot.initialize(stepResponseCanvas, flightLog.getSysConfig());

        userSettings.stepResponseAxes = userSettings.stepResponseAxes || { roll: true, pitch: true, yaw: true };
        for (const axis in userSettings.stepResponseAxes) {
            StepResponsePlot.setAxisVisible(axis, userSettings.stepResponseAxes[axis]);
        }

        this.setFullscreen = function(size) {
            isFullscreen = (size == true);
            StepResponsePlot.setFullScreen(isFullscreen);
            that.resize();
        };

        this.setInTime = function(time) {
            dataReload = true;
            return StepResponseCalc.setInTime(time);
        };

        this.setOutTime = function(time) {
            dataReload = true;
            return StepResponseCalc.setOutTime(time);
        };

        this.setAxisEnabled = function(axis, state) {
            userSettings.stepResponseAxes[axis] = state;
            saveOneUserSetting('stepResponseAxes', userSettings.stepResponseAxes);
            StepResponsePlot.setAxisVisible(axis, state);
            that.draw();
        };

        var getSize = function() {
            if (isFullscreen) {
                return {
                    height: canvas.clientHeight - STEP_RESPONSE_LARGE_HEIGHT_MARGIN,
                    width:  canvas.clientWidth - STEP_RESPONSE_LARGE_WIDTH_MARGIN,
                    left:   STEP_RESPONSE_LARGE_LEFT_MARGIN,
                    top:    STEP_RESPONSE_LARGE_TOP_MARGIN,
                };
            } else {
                return {
                    height: canvas.height * parseInt(STEP_RESPONSE_DEFAULT_POSITION.size) / 100.0,
                    width:  canvas.width * parseInt(STEP_RESPONSE_DEFAULT_POSITION.size) / 100.0,
                    left:   canvas.width * parseInt(STEP_RESPONSE_DEFAULT_POSITION.left) / 100.0,
                    top:    canvas.height * parseInt(STEP_RESPONSE_DEFAULT_POSITION.top) / 100.0,
                };
            }
        };

        this.resize = function() {

            var newSize = getSize();

            StepResponsePlot.setSize(newSize.width, newSize.height);

            var parentElem = $(stepResponseCanvas).parent();

            $(parentElem).css({
                left: newSize.left,
                top:  newSize.top,
            });

            $("#stepResponseResize", parentElem).css({
                left: (newSize.width - 28) + "px",
            });
        };

        var dataLoad = function() {
            stepResponseData = StepResponseCalc.calculate();
            StepResponsePlot.setData(stepResponseData);
        };

        this.plot = function() {
            if (dataReload || stepResponseData == null) {
                dataReload = false;
                dataLoad();
            }
            that.draw();
        };

        this.draw = function() {
            StepResponsePlot.draw();
        };

        this.destroy = function() {
            $(stepResponseCanvas).off("mousemove", trackTime);
            $(stepResponseCanvas).off("touchmove", trackTime);
        };

        /* Shift-hover to read off the response time (and per-axis value) under the mouse,
           mirroring the Analyser's shift-hover frequency readout. */
        function trackTime(e) {
            if (e.shiftKey) {
                var rect = stepResponseCanvas.getBoundingClientRect();
                var mouseX = e.clientX - rect.left;
                var mouseY = e.clientY - rect.top;

                StepResponsePlot.setMousePosition(mouseX, mouseY);
                that.draw();
                e.preventDefault();
            } else {
                StepResponsePlot.clearMousePosition();
                that.draw();
            }
        }

        $(stepResponseCanvas).on('mousemove', trackTime);
        $(stepResponseCanvas).on('touchmove', trackTime);
        $(stepResponseCanvas).on('mouseleave', function() {
            StepResponsePlot.clearMousePosition();
            that.draw();
        });

        function saveOneUserSetting(name, value) {
            prefs.get('userSettings', function(data) {
                data[name] = value;
                prefs.set('userSettings', data);
            });
        }

    } catch (e) {
        console.log('Failed to create step response panel... error:' + e);
    }
}
